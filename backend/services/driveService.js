'use strict';
/**
 * driveService.js – Google Drive file operations
 * ─────────────────────────────────────────────────────────────────
 *  Handles all Drive API interactions:
 *    • 2-level folder hierarchy: CoLearn/ → suite_{suiteId}/
 *    • Streaming file upload
 *    • File permissions (grant/revoke per suite member)
 *    • File deletion
 *
 *  FOLDER ARCHITECTURE:
 *    Each user's Google Drive contains:
 *      CoLearn/
 *        suite_{suiteId}/          ← all files for that suite
 *
 *  CACHING:
 *    • CoLearn folder ID cached in users/{uid}/privateData/driveAuth.coLearnFolderId
 *    • Suite subfolder ID cached in suites/{id}.driveFolderIdByUser.{uid}
 *    • Single drive.files.get() call per cache miss (fixed double-get bug)
 */

const { google }           = require('googleapis');
const { PassThrough }      = require('stream');
const { db, firestoreWithRetry } = require('../config/firebase');

/* ── Drive client factory ────────────────────────────────────────── */
function createDriveClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

/* ── Sanitize a folder name for Google Drive ─────────────────────── */
function sanitizeFolderName(name) {
  return (name || 'Unnamed')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 80);
}

/* ══════════════════════════════════════════════════════════════════
   _getOrCreateFolder (internal)
   Find or create a Drive folder with the given name inside a parent.
   parentId = null means root of Drive.
   ══════════════════════════════════════════════════════════════════ */
async function _getOrCreateFolder(drive, folderName, parentId) {
  // Search for an existing folder
  let q = `mimeType='application/vnd.google-apps.folder' and name='${
    folderName.replace(/'/g, "\\'")}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  let existingId = null;
  try {
    const res = await drive.files.list({
      q,
      fields:   'files(id)',
      spaces:   'drive',
      pageSize: 1,
    });
    if (res.data.files && res.data.files.length > 0) {
      existingId = res.data.files[0].id;
    }
  } catch (e) {
    console.warn(`[Drive] Folder search failed for "${folderName}", will create:`, e.message);
  }

  if (existingId) {
    console.log(`[Drive] Reusing folder "${folderName}": ${existingId}`);
    return existingId;
  }

  // Create the folder
  const body = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];

  const res    = await drive.files.create({ requestBody: body, fields: 'id' });
  const newId  = res.data.id;
  console.log(`[Drive] Created folder "${folderName}": ${newId}`);
  return newId;
}

/* ══════════════════════════════════════════════════════════════════
   getOrCreateCoLearnFolder
   Returns the ID of the user's top-level "CoLearn" folder in Drive.
   Cached in users/{uid}/privateData/driveAuth.coLearnFolderId.
   ══════════════════════════════════════════════════════════════════ */
async function getOrCreateCoLearnFolder(drive, uid) {
  // 1. Check Firestore cache
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('users').doc(uid).collection('privateData').doc('driveAuth').get()
    );
    if (snap.exists) {
      const cachedId = snap.data().coLearnFolderId;
      if (cachedId) {
        // Verify folder still exists (single get — no double-get bug)
        try {
          const f = await drive.files.get({ fileId: cachedId, fields: 'id,trashed' });
          if (!f.data.trashed) {
            console.log(`[Drive] Reusing CoLearn folder: ${cachedId} (uid=${uid})`);
            return cachedId;
          }
        } catch (e) {
          console.warn('[Drive] Cached CoLearn folder missing or inaccessible, recreating.');
        }
      }
    }
  } catch (e) {
    console.warn('[Drive] Could not read CoLearn folder cache:', e.message);
  }

  // 2. Find or create "CoLearn" in Drive root
  const folderId = await _getOrCreateFolder(drive, 'CoLearn', null);

  // 3. Cache in Firestore
  try {
    await firestoreWithRetry(() =>
      db.collection('users').doc(uid).collection('privateData').doc('driveAuth')
        .set({ coLearnFolderId: folderId }, { merge: true })
    );
  } catch (e) {
    console.warn('[Drive] Could not cache CoLearn folder ID:', e.message);
  }

  return folderId;
}

/* ══════════════════════════════════════════════════════════════════
   getOrCreateSuiteFolder  (main public API)
   Returns the Drive folder ID for a specific suite + user combination.
   Full path in Drive: CoLearn/ → suite_{suiteId}/
   Cached in suites/{id}.driveFolderIdByUser.{uid}
   Backward compatible: falls back to suites/{id}.driveFolderId for old suites.
   ══════════════════════════════════════════════════════════════════ */
async function getOrCreateSuiteFolder(accessToken, suiteId, suiteName, uid) {
  const drive = createDriveClient(accessToken);

  // 1. Check per-user suite folder cache in Firestore
  try {
    const snap = await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).get()
    );
    if (snap.exists) {
      const data      = snap.data();
      // Per-user cache first, then legacy single driveFolderId as fallback
      const cachedId  = (data.driveFolderIdByUser || {})[uid] || data.driveFolderId;
      if (cachedId) {
        try {
          const f = await drive.files.get({ fileId: cachedId, fields: 'id,trashed' });
          if (!f.data.trashed) {
            console.log(`[Drive] Reusing cached suite folder: ${cachedId} (suite=${suiteId}, uid=${uid})`);
            return cachedId;
          }
        } catch (e) {
          console.warn(`[Drive] Cached suite folder ${cachedId} missing, recreating.`);
        }
      }
    }
  } catch (e) {
    console.warn('[Drive] Could not read suite folder cache:', e.message);
  }

  // 2. Ensure the CoLearn parent folder exists for this user
  const coLearnFolderId = await getOrCreateCoLearnFolder(drive, uid);

  // 3. Create suite subfolder: suite_{suiteId} (deterministic name)
  const subfName    = `suite_${suiteId}`;
  const subfolderId = await _getOrCreateFolder(drive, subfName, coLearnFolderId);

  // 4. Cache in Firestore under driveFolderIdByUser.{uid}
  try {
    await firestoreWithRetry(() =>
      db.collection('suites').doc(suiteId).update({
        [`driveFolderIdByUser.${uid}`]:  subfolderId,
        driveFolderUpdatedAt:            new Date().toISOString(),
      })
    );
  } catch (e) {
    console.warn('[Drive] Could not cache suite subfolder ID:', e.message);
  }

  return subfolderId;
}

/* ══════════════════════════════════════════════════════════════════
   uploadFile
   Streams file data to Google Drive.
   Returns Drive file metadata.
   ══════════════════════════════════════════════════════════════════ */
async function uploadFile(accessToken, folderId, fileStream, fileName, mimeType, fileSize) {
  const drive = createDriveClient(accessToken);

  const passThrough = new PassThrough();
  fileStream.pipe(passThrough);

  let uploadRes;
  try {
    uploadRes = await drive.files.create({
      requestBody: {
        name:    fileName,
        parents: [folderId],
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body:     passThrough,
      },
      fields: 'id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,createdTime',
      uploadType: fileSize && fileSize > 5 * 1024 * 1024 ? 'resumable' : 'multipart',
    });
  } catch (e) {
    console.error('[Drive] File upload failed:', e.message);
    throw new Error(`Drive upload failed: ${e.message}`);
  }

  return uploadRes.data;
}

/* ══════════════════════════════════════════════════════════════════
   grantPermission
   Grants reader access to a specific email address.
   Returns the permission ID (for later revocation).
   ══════════════════════════════════════════════════════════════════ */
async function grantPermission(accessToken, driveFileId, emailAddress) {
  const drive = createDriveClient(accessToken);
  try {
    const permRes = await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { type: 'user', role: 'reader', emailAddress },
      fields: 'id',
      sendNotificationEmail: false,
    });
    return permRes.data.id;
  } catch (e) {
    // Non-fatal: a failed permission grant should not block upload
    console.warn(`[Drive] Could not grant permission to ${emailAddress} for ${driveFileId}:`, e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   revokePermission
   Removes a user's reader access from a Drive file.
   ══════════════════════════════════════════════════════════════════ */
async function revokePermission(accessToken, driveFileId, permissionId) {
  if (!permissionId) return;
  const drive = createDriveClient(accessToken);
  try {
    await drive.permissions.delete({ fileId: driveFileId, permissionId });
  } catch (e) {
    console.warn(`[Drive] Could not revoke permission ${permissionId} from ${driveFileId}:`, e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════
   grantFolderPermission — alias used for new member join
   ══════════════════════════════════════════════════════════════════ */
async function grantFolderPermission(accessToken, folderId, emailAddress) {
  return grantPermission(accessToken, folderId, emailAddress);
}

/* ══════════════════════════════════════════════════════════════════
   listFilesInFolder
   ══════════════════════════════════════════════════════════════════ */
async function listFilesInFolder(accessToken, folderId) {
  const drive = createDriveClient(accessToken);
  try {
    const res = await drive.files.list({
      q:       `'${folderId}' in parents and trashed=false`,
      fields:  'files(id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 100,
    });
    return res.data.files || [];
  } catch (e) {
    console.error('[Drive] listFilesInFolder failed:', e.message);
    throw new Error('Could not list Drive files.');
  }
}

/* ══════════════════════════════════════════════════════════════════
   deleteFile
   Moves file to Trash (recoverable).
   ══════════════════════════════════════════════════════════════════ */
async function deleteFile(accessToken, driveFileId) {
  const drive = createDriveClient(accessToken);
  try {
    await drive.files.update({ fileId: driveFileId, requestBody: { trashed: true } });
    console.log(`[Drive] File trashed: ${driveFileId}`);
  } catch (e) {
    console.error('[Drive] deleteFile failed:', e.message);
    throw new Error(`Could not delete Drive file: ${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   buildEmbedUrl
   ══════════════════════════════════════════════════════════════════ */
function buildEmbedUrl(driveFileId, mimeType) {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('pdf'))                                  return `https://drive.google.com/file/d/${driveFileId}/preview`;
  if (m.includes('word') || m.includes('document'))       return `https://docs.google.com/document/d/${driveFileId}/preview`;
  if (m.includes('presentation') || m.includes('pptx'))  return `https://docs.google.com/presentation/d/${driveFileId}/preview`;
  if (m.includes('spreadsheet') || m.includes('xlsx'))   return `https://docs.google.com/spreadsheets/d/${driveFileId}/preview`;
  return `https://drive.google.com/file/d/${driveFileId}/preview`;
}

/* ════════════════════════════════════════════════════════════════
   renameFile
   Renames a Drive file using the files.update PATCH endpoint.
   The file ID (content) is unchanged; only the display name changes.
   Returns the updated Drive metadata.
   ════════════════════════════════════════════════════════════════ */
async function renameFile(accessToken, driveFileId, newName) {
  const drive = createDriveClient(accessToken);
  try {
    const res = await drive.files.update({
      fileId:      driveFileId,
      requestBody: { name: newName },
      fields:      'id,name',
    });
    console.log(`[Drive] Renamed file ${driveFileId} to "${newName}"`);
    return res.data;
  } catch (e) {
    console.error('[Drive] renameFile failed:', e.message);
    throw new Error(`Could not rename Drive file: ${e.message}`);
  }
}

module.exports = {
  getOrCreateSuiteFolder,
  getOrCreateCoLearnFolder,
  uploadFile,
  grantPermission,
  revokePermission,
  grantFolderPermission,
  listFilesInFolder,
  deleteFile,
  buildEmbedUrl,
  sanitizeFolderName,
  renameFile,
};
