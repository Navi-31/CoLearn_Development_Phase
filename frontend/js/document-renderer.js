/**
 * document-renderer.js
 * Handles UI generation and rendering for the Document Management system.
 */

var DocumentRenderer = (function () {
  
  var categoryLabels = {
    'pdf': '📄 PDF Documents',
    'document': '📝 Word Documents',
    'presentation': '📊 Presentations',
    'spreadsheet': '📈 Spreadsheets',
    'image': '🖼️ Images',
    'video': '🎬 Videos',
    'audio': '🎵 Audio',
    'archive': '📦 Archives',
    'other': '📎 Other Files'
  };

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
  }

  function _getDriveFileIcon(mimeType, fileName) {
    var mime = (mimeType || '').toLowerCase();
    var name = (fileName || '').toLowerCase();
    
    if (mime.includes('pdf') || name.endsWith('.pdf')) return '📄';
    if (mime.includes('word') || mime.includes('document') || name.match(/\.(doc|docx)$/)) return '📝';
    if (mime.includes('spreadsheet') || mime.includes('excel') || name.match(/\.(xls|xlsx|csv)$/)) return '📈';
    if (mime.includes('presentation') || mime.includes('powerpoint') || name.match(/\.(ppt|pptx)$/)) return '📊';
    if (mime.includes('image') || name.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/)) return '🖼️';
    if (mime.includes('video') || name.match(/\.(mp4|webm|mov|avi|mkv)$/)) return '🎬';
    if (mime.includes('audio') || name.match(/\.(mp3|wav|ogg|m4a|flac)$/)) return '🎵';
    if (mime.includes('zip') || mime.includes('compressed') || name.match(/\.(zip|tar|gz|rar|7z)$/)) return '📦';
    
    return '📎';
  }

  return {
    renderCategoryHeader: function(fileType) {
      var header = document.createElement('div');
      header.className = 'drive-category-header';
      header.dataset.category = fileType;
      header.textContent = categoryLabels[fileType] || categoryLabels['other'];
      return header;
    },

    renderDocumentCard: function(file, canDelete, suiteId) {
      var card = document.createElement('div');
      card.className       = 'drive-file-card doc-pending-card';
      card.id              = 'drive-file-' + file.id;
      card.dataset.fileId  = file.id;
      card.dataset.driveId = file.driveFileId || '';
      card.dataset.fileType = file.fileType || 'other';

      var icon = _getDriveFileIcon(file.mimeType, file.fileName);

      card.innerHTML =
        '<div class="doc-pending-icon">' + icon + '</div>' +
        '<div class="doc-pending-info">' +
          '<div class="doc-pending-name" title="' + escapeHtml(file.fileName || '') + '">' + escapeHtml(file.fileName || 'Untitled') + '</div>' +
        '</div>';

      // Left click opens overlay
      card.onclick = function(e) {
        if (e.button === 0) {
          if (typeof window.openDriveFileViewer === 'function') {
            window.openDriveFileViewer(file);
          }
        }
      };

      // Right click opens context menu
      card.oncontextmenu = function(e) {
        e.preventDefault();
        DocumentRenderer.renderContextMenu(e.pageX, e.pageY, file, canDelete, suiteId);
      };

      return card;
    },

    renderPendingUploadCard: function(doc) {
      var card = document.createElement('div');
      card.className = 'doc-pending-card';
      card.id = 'doc-card-' + doc.id;

      var progressHtml = '';
      if (doc.status === 'uploading') {
        progressHtml = 
          '<div class="doc-progress-bar" style="width:100%;height:6px;background:var(--c-divider);border-radius:4px;margin-top:8px;overflow:hidden;">' +
            '<div class="doc-progress-fill" style="width:' + (doc.progress || 0) + '%;height:100%;background:var(--fl-accent, #2563eb);transition:width 0.3s;"></div>' +
          '</div>';
      } else if (doc.status === 'error') {
        progressHtml = '<div style="color:var(--fl-red, #dc2626);font-size:0.75rem;margin-top:4px;">⚠️ Upload failed</div>';
      } else if (doc.status === 'paused') {
        progressHtml = '<div style="color:var(--fl-text-lo, #64748b);font-size:0.75rem;margin-top:4px;">⏸️ Upload paused</div>';
      }

      var actionsHtml = '<div class="doc-pending-actions" style="display:flex;gap:4px;">';
      if (doc.status === 'uploading') {
        actionsHtml += '<button class="doc-action-btn" onclick="if(window.DocumentService) window.DocumentService.pauseUpload(\'' + doc.id + '\')" title="Pause">⏸️</button>';
      } else if (doc.status === 'paused') {
        actionsHtml += '<button class="doc-action-btn" onclick="if(window.DocumentService) window.DocumentService.resumeUpload(\'' + doc.id + '\')" title="Resume">▶️</button>';
      } else if (doc.status === 'error') {
        actionsHtml += '<button class="doc-action-btn" onclick="if(window.attemptDriveUpload) attemptDriveUpload(\'' + doc.id + '\')" title="Retry">🔄</button>';
      }
      
      // Always allow remove
      actionsHtml += '<button class="doc-action-btn danger" onclick="if(window.removePendingDocument) removePendingDocument(\'' + doc.id + '\')" title="Cancel/Remove">✖</button>';
      actionsHtml += '</div>';

      card.innerHTML =
        '<div class="doc-pending-icon">' + _getDriveFileIcon('', doc.name) + '</div>' +
        '<div class="doc-pending-info" style="align-items:flex-start!important;width:100%;">' +
          '<div class="doc-pending-name" style="width:100%;text-align:left;" title="' + escapeHtml(doc.name || '') + '">' + escapeHtml(doc.name || 'Untitled') + '</div>' +
          progressHtml +
        '</div>' + actionsHtml;

      return card;
    },

    renderContextMenu: function(x, y, file, canDelete, suiteId) {
      var menu = document.getElementById('doc-context-menu');
      if (!menu) {
        menu = document.createElement('div');
        menu.id = 'doc-context-menu';
        document.body.appendChild(menu);
      }
      
      menu.innerHTML = '';
      
      var downloadUrl = file.driveDownloadLink || file.driveWebViewLink || '#';
      
      var btnDownload = document.createElement('button');
      btnDownload.className = 'cm-btn';
      btnDownload.innerHTML = '⬇️ Download';
      btnDownload.onclick = function() {
        window.open(downloadUrl, '_blank');
        menu.style.display = 'none';
      };
      menu.appendChild(btnDownload);

      if (canDelete) {
        var btnRename = document.createElement('button');
        btnRename.className = 'cm-btn';
        btnRename.innerHTML = '✏️ Rename';
        btnRename.onclick = async function() {
          menu.style.display = 'none';
          var newName = prompt('Enter new document name:', file.fileName);
          if (newName && newName.trim() !== file.fileName) {
            try {
              var res = await window.API.renameDriveFile(file.id, newName.trim(), suiteId);
              if (res && res.success) {
                if (window.showToast) window.showToast('main-toast', '✅ File renamed successfully.', 'dark');
                // Optimistic UI update
                var cardNameEl = document.querySelector('#drive-file-' + file.id + ' .doc-pending-name');
                if (cardNameEl) cardNameEl.textContent = res.newName;
              } else {
                if (window.showToast) window.showToast('main-toast', '⚠️ Failed to rename file: ' + (res.error || 'Unknown error'), 'dark');
              }
            } catch(e) {
              if (window.showToast) window.showToast('main-toast', '⚠️ Error renaming file.', 'dark');
            }
          }
        };
        menu.appendChild(btnRename);

        var btnDelete = document.createElement('button');
        btnDelete.className = 'cm-btn cm-danger';
        btnDelete.innerHTML = '🗑️ Delete';
        btnDelete.onclick = function() {
          menu.style.display = 'none';
          if (typeof window.deleteDriveFile === 'function') {
            window.deleteDriveFile(file.id, suiteId);
          }
        };
        menu.appendChild(btnDelete);
      }

      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.display = 'flex';
    },

    renderDocumentOverlay: function(file) {
      if (!file) return;

      var mimeType = (file.mimeType || '').toLowerCase();
      var fileName = file.fileName || 'Document';
      var icon = _getDriveFileIcon(mimeType, fileName);
      var downloadUrl = file.driveDownloadLink || file.driveWebViewLink || '#';
      var embedUrl = file.driveEmbedUrl || (mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf') ? file.driveWebViewLink : '');
      var directMediaUrl = file.driveDownloadLink || file.driveWebViewLink || '';

      var isImg = mimeType.includes('image') || ['png','jpg','jpeg','gif','webp','svg','bmp'].some(function (e) { return fileName.toLowerCase().endsWith('.' + e); });
      var isVid = mimeType.includes('video') || ['mp4','webm','mov','avi','mkv'].some(function (e) { return fileName.toLowerCase().endsWith('.' + e); });
      var isAud = mimeType.includes('audio') || ['mp3','wav','ogg','m4a','flac'].some(function (e) { return fileName.toLowerCase().endsWith('.' + e); });

      var contentHtml = '';
      if (isImg) {
        contentHtml = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;box-sizing:border-box;background:#f8fafc;"><img src="' + escapeHtml(directMediaUrl) + '" alt="' + escapeHtml(fileName) + '" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,0.12);background:#ffffff;" /></div>';
      } else if (isVid) {
        contentHtml = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;box-sizing:border-box;background:#0f172a;"><video controls autoplay playsinline src="' + escapeHtml(directMediaUrl) + '" style="max-width:90%;max-height:85%;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.4);"></video></div>';
      } else if (isAud) {
        contentHtml = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:1.5rem;background:#f8fafc;"><div style="font-size:4.5rem;">' + icon + '</div><div style="font-size:1.2rem;font-weight:700;color:#1e293b;">' + escapeHtml(fileName) + '</div><audio controls autoplay src="' + escapeHtml(directMediaUrl) + '" style="width:440px;max-width:90%;"></audio></div>';
      } else if (embedUrl) {
        contentHtml = '<iframe src="' + escapeHtml(embedUrl) + '" frameborder="0" allowfullscreen style="width:100%;height:100%;border:none;display:block;background:#ffffff;"></iframe>';
      } else if (file.driveWebViewLink) {
        contentHtml = '<iframe src="' + escapeHtml(file.driveWebViewLink) + '" frameborder="0" allowfullscreen style="width:100%;height:100%;border:none;display:block;background:#ffffff;"></iframe>';
      } else {
        contentHtml = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:1rem;color:#64748b;background:#f8fafc;"><div style="font-size:4rem;">' + icon + '</div><div style="font-size:1.25rem;font-weight:700;color:#1e293b;">' + escapeHtml(fileName) + '</div><div style="font-size:0.9rem;">Preview is not directly embeddable for this format.</div><a href="' + escapeHtml(downloadUrl) + '" target="_blank" style="padding:12px 28px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;margin-top:0.5rem;box-shadow:0 4px 14px rgba(37,99,235,0.3);">⬇️ Download File</a></div>';
      }

      var viewerTab = window.open('', '_blank');
      if (viewerTab) {
        var pageHtml = '<!DOCTYPE html>' +
          '<html><head><meta charset="utf-8">' +
          '<title>' + escapeHtml(fileName) + ' – CoLearn Viewer</title>' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<style>' +
          '* { box-sizing: border-box; margin: 0; padding: 0; }' +
          'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #ffffff; color: #0f172a; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }' +
          '.cl-viewer-header { background: #ffffff; padding: 0.75rem 1.5rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }' +
          '.cl-viewer-title-box { display: flex; align-items: center; gap: 10px; overflow: hidden; }' +
          '.cl-viewer-title { font-weight: 700; font-size: 1rem; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65vw; }' +
          '.cl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.45rem 1rem; font-size: 0.85rem; font-weight: 600; border-radius: 6px; text-decoration: none; cursor: pointer; border: 1px solid #cbd5e1; background: #2563eb; color: #ffffff; transition: background 0.15s; }' +
          '.cl-btn:hover { background: #1d4ed8; }' +
          '.cl-viewer-body { flex: 1; width: 100%; height: 100%; background: #ffffff; overflow: hidden; display: flex; align-items: center; justify-content: center; }' +
          '</style></head><body>' +
          '<div class="cl-viewer-header">' +
            '<div class="cl-viewer-title-box">' +
              '<span style="font-size:1.5rem;">' + icon + '</span>' +
              '<span class="cl-viewer-title">' + escapeHtml(fileName) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<a href="' + escapeHtml(downloadUrl) + '" target="_blank" class="cl-btn">⬇️ Download</a>' +
            '</div>' +
          '</div>' +
          '<div class="cl-viewer-body">' + contentHtml + '</div>' +
          '</body></html>';

        viewerTab.document.open();
        viewerTab.document.write(pageHtml);
        viewerTab.document.close();
      } else if (file.driveWebViewLink) {
        window.open(file.driveWebViewLink, '_blank');
      }
    },

    setupAccessibility: function() {
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          var menu = document.getElementById('doc-context-menu');
          if (menu && menu.style.display === 'flex') menu.style.display = 'none';
        }
      });

      document.addEventListener('click', function(e) {
        var menu = document.getElementById('doc-context-menu');
        if (menu && menu.style.display === 'flex') {
          if (!menu.contains(e.target)) {
            menu.style.display = 'none';
          }
        }
      });
    }
  };
})();

// Initialize global accessibility listeners
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', DocumentRenderer.setupAccessibility);
} else {
  DocumentRenderer.setupAccessibility();
}
