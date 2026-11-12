'use strict';

/**
 * Controller for the AI Buddy (Study Partner) workspace view.
 * Redesigned as a fly-out sidebar copilot overlay (similar to Microsoft Copilot/ChatGPT).
 * Supports:
 * - Word-by-word typewriter streaming
 * - Markdown parsing, block code formatting, and code/bubble copying
 * - WhatsApp-style User Message Editing (re-branches and submits history from that point)
 * - Interactive Emoji Picker inside the panel
 */

// Initialize AI Chat History in AppState if not present
if (typeof AppState !== 'undefined') {
  if (!AppState.aiChatHistory) {
    AppState.aiChatHistory = [];
  }
}

/**
 * Toggles the AI Buddy slide-out sidebar panel.
 */
function toggleAIBuddy() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;

  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    closeAIBuddy();
  } else {
    openAIBuddy();
  }
}

/**
 * Opens the AI Buddy panel and handles sidebar constraints.
 */
function openAIBuddy() {
  const panel = document.getElementById('ai-panel');
  const btn = document.getElementById('btn-ai');
  if (!panel) return;

  // 1. Close standard chat panel if open to prevent stacking
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel && chatPanel.classList.contains('open')) {
    if (typeof toggleChat === 'function') toggleChat();
  }

  // 2. Close private chat panel if open
  if (typeof closePrivateChatPanel === 'function') {
    closePrivateChatPanel();
  }

  // 3. Mark active state
  panel.classList.add('open');
  if (btn) btn.classList.add('active-tool');
  AppState.aiOpen = true;

  // Render conversation content
  renderAIChatHistory();

  // Scroll to bottom
  const messagesContainer = document.getElementById('ai-chat-messages');
  if (messagesContainer) {
    setTimeout(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 50);
  }
}

/**
 * Closes the AI Buddy panel.
 */
function closeAIBuddy() {
  const panel = document.getElementById('ai-panel');
  const btn = document.getElementById('btn-ai');
  if (!panel) return;

  panel.classList.remove('open');
  if (btn) btn.classList.remove('active-tool');
  AppState.aiOpen = false;

  // Close emoji picker if open
  const picker = document.getElementById('ai-emoji-picker');
  if (picker) picker.classList.add('hidden');
}

/**
 * Helper to escape HTML characters for safe injection.
 * Fallback in case utils.js escapeHtml is missing.
 */
function safeEscape(str) {
  if (typeof escapeHtml === 'function') {
    return escapeHtml(str);
  }
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Parses Markdown-style tables into HTML tables.
 */
function parseMarkdownTables(html) {
  const lines = html.split('<br>');
  let inTable = false;
  let tableHtml = '';
  let newLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
      
      if (!inTable) {
        inTable = true;
        tableHtml = '<table style="border-collapse: collapse; width: 100%; margin: 0.8rem 0; border: 1.5px solid var(--c-divider); font-size: 0.82rem; text-align: left;"><thead><tr style="background: var(--c-lightgray);">';
        tableHtml += cells.map(c => `<th style="padding: 0.5rem; border: 1px solid var(--c-divider); font-weight: 700;">${c}</th>`).join('');
        tableHtml += '</tr></thead><tbody>';
      } else {
        // Check if this is a separator line (e.g. ---|---)
        if (line.includes('---') || line.includes(':::')) {
          continue; // Skip the separator row
        }
        tableHtml += '<tr>';
        tableHtml += cells.map(c => `<td style="padding: 0.5rem; border: 1px solid var(--c-divider); background: var(--c-white);">${c}</td>`).join('');
        tableHtml += '</tr>';
      }
    } else {
      if (inTable) {
        inTable = false;
        tableHtml += '</tbody></table>';
        newLines.push(tableHtml);
        tableHtml = '';
      }
      newLines.push(lines[i]);
    }
  }
  
  if (inTable) {
    tableHtml += '</tbody></table>';
    newLines.push(tableHtml);
  }
  
  return newLines.join('<br>');
}

/**
 * Custom Markdown and formatting parser for AI responses.
 * Highlights code blocks, inline code, bold text, and lists.
 */
function formatAIMarkdown(text) {
  if (!text) return '';
  
  let html = safeEscape(text);

  // 1. Parse multi-line code blocks: ```lang\n [code] \n```
  html = html.replace(/```([a-zA-Z0-9-]+)?\n([\s\S]*?)\n```/g, (match, lang, code) => {
    const language = lang || 'code';
    // We escape double quotes in data attributes to avoid breaking HTML structure
    const safeRawCode = code.replace(/"/g, '&quot;');
    return `
      <div style="margin: 0.6rem 0; border-radius: 8px; overflow: hidden; box-shadow: var(--shadow-sm); border: 1.5px solid var(--c-divider);">
        <div style="background: var(--c-charcoal); color: #dee2e6; padding: 0.35rem 0.8rem; font-size: 0.72rem; font-weight: 700; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <span>${language.toUpperCase()}</span>
          <button class="ai-copy-btn" onclick="copyCodeSnippet(this)" style="color: #dee2e6; padding: 2px 6px;" title="Copy code">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy Code</span>
          </button>
        </div>
        <pre style="background: var(--c-darkgray); color: #f8f9fa; padding: 0.8rem 1rem; overflow-x: auto; font-family: monospace; font-size: 0.82rem; margin: 0; white-space: pre;"><code class="raw-code" data-raw="${safeRawCode}">${code}</code></pre>
      </div>
    `;
  });

  // 2. Parse inline code: `code`
  html = html.replace(/`([^`\n]+)`/g, '<code style="background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.85em; color: var(--c-navy); font-weight: 500;">$1</code>');

  // 3. Parse bold text: **bold**
  html = html.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');

  // 4. Parse italic text: *italic* or _italic_
  html = html.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');

  // 5. Parse bullet lists: ^* item or ^- item
  html = html.replace(/^(?:\s*[-*]\s+)(.+)$/gm, '<li style="margin-left: 1.25rem; margin-top: 0.25rem; list-style-type: disc; line-height: 1.6; text-align: left;">$1</li>');

  // 6. Convert newlines to breaks
  html = html.replace(/\n/g, '<br>');

  // 7. Parse and format Markdown tables
  html = parseMarkdownTables(html);

  return html;
}

/**
 * Copy bubble raw text to the clipboard.
 */
async function copyAIBubbleText(btn) {
  const bubble = btn.closest('.ai-message-bubble');
  if (!bubble) return;
  const textEl = bubble.querySelector('.ai-message-bubble-text');
  if (!textEl) return;
  const rawText = textEl.getAttribute('data-raw') || textEl.innerText;

  try {
    if (typeof copyToClipboard === 'function') {
      await copyToClipboard(rawText);
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(rawText);
    }
    
    // Feedback transition on button
    const span = btn.querySelector('span');
    if (span) {
      const original = span.textContent;
      span.textContent = 'Copied!';
      setTimeout(() => { span.textContent = original; }, 2000);
    }
  } catch (e) {
    console.error('Clipboard copy failed:', e);
  }
}

/**
 * Copy inner pre-formatted code block to the clipboard.
 */
async function copyCodeSnippet(btn) {
  const container = btn.closest('div').nextElementSibling; // Get the <pre> element
  if (!container) return;
  const codeEl = container.querySelector('.raw-code');
  if (!codeEl) return;
  const code = codeEl.getAttribute('data-raw') || codeEl.innerText;

  try {
    if (typeof copyToClipboard === 'function') {
      await copyToClipboard(code);
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(code);
    }
    const span = btn.querySelector('span');
    if (span) {
      span.textContent = 'Copied!';
      setTimeout(() => { span.textContent = 'Copy Code'; }, 2000);
    }
  } catch (e) {
    console.error('Code copy failed:', e);
  }
}

/**
 * Simulates a streaming typewriter effect, rendering character/word sequences dynamically.
 */
function streamTypewriter(element, text, speedMs = 15) {
  return new Promise((resolve) => {
    // Split text by words and whitespaces
    const tokens = text.split(/(\s+)/);
    let index = 0;
    let currentText = '';
    const container = document.getElementById('ai-chat-messages');

    function renderNextToken() {
      if (index >= tokens.length) {
        // Stream completed
        element.setAttribute('data-raw', text);
        resolve();
        return;
      }

      currentText += tokens[index];
      index++;

      // Update innerHTML using formatting pipeline
      element.innerHTML = formatAIMarkdown(currentText);

      // Keep user viewport scrolled at bottom
      if (container) {
        container.scrollTop = container.scrollHeight;
      }

      setTimeout(renderNextToken, speedMs);
    }

    renderNextToken();
  });
}

/**
 * WhatsApp-style user message prompt editing.
 * Replaces the prompt with a text-editor and re-evaluates the conversation from that index.
 */
window.editUserMessage = function(index, btn) {
  const bubble = btn.closest('.ai-message-bubble');
  if (!bubble) return;
  
  // Close emoji picker if open
  const picker = document.getElementById('ai-emoji-picker');
  if (picker) picker.classList.add('hidden');

  const rawText = AppState.aiChatHistory[index].content;

  bubble.innerHTML = `
    <div style="width: 100%; display: flex; flex-direction: column; gap: 0.5rem; text-align: left;">
      <textarea class="fs-input" style="font-family: inherit; font-size: 0.85rem; padding: 0.45rem 0.6rem; min-height: 60px; background: #fff; color: var(--c-charcoal); border-radius: 6px; border: 1.5px solid var(--c-blue); outline: none; resize: vertical; box-shadow: 0 0 0 3px rgba(0,123,255,0.15);" id="ai-edit-input-${index}">${safeEscape(rawText)}</textarea>
      <div style="display: flex; gap: 0.4rem; justify-content: flex-end; width: 100%;">
        <button class="btn-primary" style="font-size: 0.72rem; padding: 0.25rem 0.6rem; border-radius: 4px; line-height: 1;" onclick="saveUserMessageEdit(${index})">Save & Submit</button>
        <button class="btn-outline" style="font-size: 0.72rem; padding: 0.25rem 0.6rem; border-radius: 4px; background: #fff; border-color: var(--c-divider); color: var(--c-slate); line-height: 1;" onclick="renderAIChatHistory()">Cancel</button>
      </div>
    </div>
  `;
};

/**
 * Saves user edit value, truncates subsequent conversation branch, and requests AI completions.
 */
window.saveUserMessageEdit = async function(index) {
  const inputEl = document.getElementById(`ai-edit-input-${index}`);
  if (!inputEl) return;
  const newValue = inputEl.value.trim();
  if (!newValue) return;

  // 1. Update history value
  AppState.aiChatHistory[index].content = newValue;

  // 2. Truncate conversation history after this user message
  AppState.aiChatHistory = AppState.aiChatHistory.slice(0, index + 1);

  // 3. Re-render viewport history to show edited message and clear future messages
  renderAIChatHistory();

  // 4. Trigger backend processing for this edited prompt
  const messagesContainer = document.getElementById('ai-chat-messages');
  const typingIndicator = document.getElementById('ai-typing-indicator');
  const modelSelect = document.getElementById('ai-model-select');
  
  if (!messagesContainer || !typingIndicator) return;

  // Show typing indicator
  typingIndicator.classList.remove('hidden');
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  const selectedModel = modelSelect ? modelSelect.value : '';

  try {
    const contextHistory = AppState.aiChatHistory.slice(-20);
    const data = await API.chatWithAI(contextHistory, selectedModel);

    // Hide typing indicator
    typingIndicator.classList.add('hidden');

    if (data && data.success && data.message) {
      const assistantMsg = data.message;
      AppState.aiChatHistory.push(assistantMsg);
      await appendAIBubbleStreaming(assistantMsg);
    } else {
      const errorMsg = (data && data.error) || 'Failed to get a response from AI Buddy.';
      appendAIBubble({ role: 'system-error', content: `⚠️ ${errorMsg}` });
    }
  } catch (err) {
    typingIndicator.classList.add('hidden');
    console.error('[AI Buddy] Edit request failed:', err);
    appendAIBubble({ role: 'system-error', content: `❌ Error: ${err.message}` });
  }

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
};

/**
 * EMOJI PICKER ACTIONS
 */

/**
 * Toggles the interactive emoji picker container.
 */
function toggleAIEmojiPicker() {
  const picker = document.getElementById('ai-emoji-picker');
  if (!picker) return;
  
  const isHidden = picker.classList.contains('hidden');
  if (isHidden) {
    // Lazy build the emoji buttons
    if (!picker.innerHTML) {
      const emojis = ['😀','😂','😍','🤔','😎','😢','😄','😅','🥳','👍','👎','🙏',
                      '🔥','❤️','💯','🎉','🚀','✔️','❌','❓','⚠️','🤗','💤','⌛',
                      '📝','📚','💻','📱','🌍','👨‍💻','🌟','🤝'];
      picker.innerHTML = emojis.map(e => {
        return `<button class="pc-emoji-btn" onclick="insertAIEmoji('${e}')" type="button" style="font-size:1.2rem;background:none;border:none;cursor:pointer;border-radius:6px;padding:3px;line-height:1;display:inline-flex;align-items:center;justify-content:center;">${e}</button>`;
      }).join('');
    }
    picker.classList.remove('hidden');
  } else {
    picker.classList.add('hidden');
  }
}

/**
 * Inserts the clicked emoji into the input prompt.
 */
window.insertAIEmoji = function(emoji) {
  const inp = document.getElementById('ai-chat-input');
  if (inp) {
    inp.value += emoji;
    inp.focus();
  }
  const picker = document.getElementById('ai-emoji-picker');
  if (picker) {
    picker.classList.add('hidden');
  }
};

/**
 * Sends a message from the input box to the AI.
 */
async function sendAIMessage() {
  const inputEl = document.getElementById('ai-chat-input');
  if (!inputEl) return;

  const content = inputEl.value.trim();
  if (!content) return;

  // Clear input field
  inputEl.value = '';

  // Close emoji picker if open
  const picker = document.getElementById('ai-emoji-picker');
  if (picker) picker.classList.add('hidden');

  await executeAIChatRequest(content);
}

/**
 * Executes a chat completion request to the AI Buddy backend.
 */
async function executeAIChatRequest(userPrompt) {
  const messagesContainer = document.getElementById('ai-chat-messages');
  const typingIndicator = document.getElementById('ai-typing-indicator');
  const modelSelect = document.getElementById('ai-model-select');
  
  if (!messagesContainer || !typingIndicator) return;

  // If this is the first message, clear the greeting starter dashboard
  if (AppState.aiChatHistory.length === 0) {
    messagesContainer.innerHTML = '';
    if (typingIndicator) {
      messagesContainer.appendChild(typingIndicator);
    }
  }

  // 1. Add user message to history & view
  const userMsg = { role: 'user', content: userPrompt };
  AppState.aiChatHistory.push(userMsg);
  appendAIBubble(userMsg, AppState.aiChatHistory.length - 1);

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // 2. Show typing indicator
  typingIndicator.classList.remove('hidden');
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Get selected model
  const selectedModel = modelSelect ? modelSelect.value : '';

  try {
    // 3. Call backend OpenRouter API proxy
    // We send the whole conversation history for context (capped to the last 20 messages for efficiency)
    const contextHistory = AppState.aiChatHistory.slice(-20);
    const data = await API.chatWithAI(contextHistory, selectedModel);

    // Hide typing indicator
    typingIndicator.classList.add('hidden');

    if (data && data.success && data.message) {
      const assistantMsg = data.message; // { role: 'assistant', content: '...' }
      AppState.aiChatHistory.push(assistantMsg);
      await appendAIBubbleStreaming(assistantMsg); // Stream the new AI message!
    } else {
      const errorMsg = (data && data.error) || 'Failed to get a response from AI Buddy.';
      appendAIBubble({ role: 'system-error', content: `⚠️ ${errorMsg}` });
    }
  } catch (err) {
    typingIndicator.classList.add('hidden');
    console.error('[AI Buddy] Request failed:', err);
    appendAIBubble({ role: 'system-error', content: `❌ Error: ${err.message}` });
  }

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

/**
 * Handle quick suggestion card actions.
 */
async function sendAIPrompt(type) {
  let promptText = '';
  switch (type) {
    case 'summarize':
      promptText = 'Can you summarize the core learning concepts we should focus on during this study session?';
      break;
    case 'explain':
      promptText = 'Could you explain a difficult concept in simple terms, using a creative analogy?';
      break;
    case 'quiz':
      promptText = 'Generate 3 quick practice questions to test my understanding of our study topics.';
      break;
    case 'debug':
      promptText = 'Help me review this code or logic. Can you find bugs in a snippet, explain the issues, and show how to fix them?';
      break;
    default:
      return;
  }

  await executeAIChatRequest(promptText);
}

/**
 * Clears the AI Chat conversation history.
 */
function clearAIChat() {
  if (confirm('Are you sure you want to clear your conversation history with AI Buddy?')) {
    AppState.aiChatHistory = [];
    renderAIChatHistory();
  }
}

/**
 * Renders all messages from history. If empty, renders the ChatGPT-style home.
 */
function renderAIChatHistory() {
  const messagesContainer = document.getElementById('ai-chat-messages');
  const indicator = document.getElementById('ai-typing-indicator');
  if (!messagesContainer) return;

  // Clear previous bubbles
  messagesContainer.innerHTML = '';
  if (indicator) {
    messagesContainer.appendChild(indicator);
  }

  // 1. If empty history, render gorgeous starter dashboard
  if (AppState.aiChatHistory.length === 0) {
    const welcomeWrap = document.createElement('div');
    welcomeWrap.className = 'ai-welcome-container';
    welcomeWrap.innerHTML = `
      <div class="ai-glowing-avatar">🤖</div>
      <h3 class="ai-welcome-title">AI Study Buddy</h3>
      <p class="ai-welcome-subtitle">Your personal study companion. Select a prompt below or start chatting!</p>
      
      <div class="ai-suggestions-grid">
        <div class="ai-suggestion-card" onclick="sendAIPrompt('summarize')">
          <span class="ai-card-icon">📝</span>
          <div class="ai-card-title">Summarize Notes</div>
          <div class="ai-card-desc">Condense session materials</div>
        </div>
        <div class="ai-suggestion-card" onclick="sendAIPrompt('explain')">
          <span class="ai-card-icon">💡</span>
          <div class="ai-card-title">Explain Concept</div>
          <div class="ai-card-desc">Simplify with an analogy</div>
        </div>
        <div class="ai-suggestion-card" onclick="sendAIPrompt('quiz')">
          <span class="ai-card-icon">❓</span>
          <div class="ai-card-title">Generate Quiz</div>
          <div class="ai-card-desc">3 quick questions to test</div>
        </div>
        <div class="ai-suggestion-card" onclick="sendAIPrompt('debug')">
          <span class="ai-card-icon">💻</span>
          <div class="ai-card-title">Debug Code</div>
          <div class="ai-card-desc">Review compiler or logic bugs</div>
        </div>
      </div>
    `;
    messagesContainer.insertBefore(welcomeWrap, indicator);
    return;
  }

  // 2. Otherwise, render rest of the history (static rendering for existing chats)
  AppState.aiChatHistory.forEach((msg, index) => {
    appendAIBubble(msg, index);
  });
}

/**
 * Appends a bubble statically (for historical chats).
 */
function appendAIBubble(msg, index) {
  const messagesContainer = document.getElementById('ai-chat-messages');
  const indicator = document.getElementById('ai-typing-indicator');
  if (!messagesContainer) return;

  const bubble = document.createElement('div');
  
  if (msg.role === 'user') {
    bubble.className = 'ai-message-bubble user';
    bubble.dataset.index = index;
    bubble.innerHTML = `
      <div class="ai-message-bubble-header">
        <span>You</span>
        <div style="display:flex;gap:0.4rem;align-items:center;user-select:none;">
          <button class="ai-action-btn-bubble" onclick="editUserMessage(${index}, this)" title="Edit message">
            ✏️ Edit
          </button>
          <button class="ai-copy-btn" onclick="copyAIBubbleText(this)" title="Copy text">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>Copy</span>
          </button>
        </div>
      </div>
      <div class="ai-message-bubble-text" data-raw="${safeEscape(msg.content)}">${safeEscape(msg.content)}</div>
    `;
  } else if (msg.role === 'assistant') {
    bubble.className = 'ai-message-bubble assistant';
    bubble.innerHTML = `
      <div class="ai-message-bubble-header">
        <span style="font-weight:700;color:var(--c-blue);">🤖 Study Buddy</span>
        <button class="ai-copy-btn" onclick="copyAIBubbleText(this)" title="Copy answer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>Copy</span>
        </button>
      </div>
      <div class="ai-message-bubble-text" data-raw="${safeEscape(msg.content)}">${formatAIMarkdown(msg.content)}</div>
    `;
  } else if (msg.role === 'system-error') {
    bubble.className = 'ai-message-bubble system-error';
    bubble.innerHTML = `
      <div class="ai-message-bubble-header">
        <span style="font-weight:700;">System Error</span>
      </div>
      <div class="ai-message-bubble-text" data-raw="${safeEscape(msg.content)}">${safeEscape(msg.content)}</div>
    `;
  }

  // Insert before the typing indicator
  if (indicator) {
    messagesContainer.insertBefore(bubble, indicator);
  } else {
    messagesContainer.appendChild(bubble);
  }
}

/**
 * Appends a bubble with a typewriter streaming animation (for incoming responses).
 */
async function appendAIBubbleStreaming(msg) {
  const messagesContainer = document.getElementById('ai-chat-messages');
  const indicator = document.getElementById('ai-typing-indicator');
  if (!messagesContainer) return;

  const bubble = document.createElement('div');
  bubble.className = 'ai-message-bubble assistant';
  
  bubble.innerHTML = `
    <div class="ai-message-bubble-header">
      <span style="font-weight:700;color:var(--c-blue);">🤖 Study Buddy</span>
      <button class="ai-copy-btn" onclick="copyAIBubbleText(this)" title="Copy answer">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        <span>Copy</span>
      </button>
    </div>
    <div class="ai-message-bubble-text" data-raw="">⏳...</div>
  `;

  // Insert before the typing indicator
  if (indicator) {
    messagesContainer.insertBefore(bubble, indicator);
  } else {
    messagesContainer.appendChild(bubble);
  }

  const textContainer = bubble.querySelector('.ai-message-bubble-text');
  
  // Stream typewriter text
  await streamTypewriter(textContainer, msg.content, 20);
}
