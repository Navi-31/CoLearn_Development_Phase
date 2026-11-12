const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') }); } catch (_) {}
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const fetch = require('node-fetch');

const firebaseConfig = {
  apiKey:      process.env.FIREBASE_API_KEY || 'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
  authDomain:  process.env.FIREBASE_AUTH_DOMAIN || 'your-firebase-project-id.firebaseapp.com',
  projectId:   process.env.FIREBASE_PROJECT_ID || 'your-firebase-project-id',
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://your-firebase-project-id-default-rtdb.firebaseio.com',
};

const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || 'password123!';

async function testRoles() {
  const appA = initializeApp(firebaseConfig, 'appA');
  const appB = initializeApp(firebaseConfig, 'appB');
  const appC = initializeApp(firebaseConfig, 'appC');

  console.log('Logging in test accounts...');
  const authA = getAuth(appA);
  const userA = await signInWithEmailAndPassword(authA, 'testA_host@example.com', TEST_PASSWORD);
  const tokenA = await userA.user.getIdToken();

  const authB = getAuth(appB);
  const userB = await signInWithEmailAndPassword(authB, 'testB_admin@example.com', TEST_PASSWORD);
  const tokenB = await userB.user.getIdToken();

  const authC = getAuth(appC);
  const userC = await signInWithEmailAndPassword(authC, 'testC_member@example.com', TEST_PASSWORD);
  const tokenC = await userC.user.getIdToken();

  const uidA = userA.user.uid;
  const uidB = userB.user.uid;
  const uidC = userC.user.uid;
  console.log(`UIDs: A=${uidA}, B=${uidB}, C=${uidC}`);

  const BASE_URL = 'http://localhost:3000';
  const headers = (uid) => ({ 'Content-Type': 'application/json', 'x-fs-uid': uid });

  // 1. A Creates a suite
  const suiteRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: headers(uidA),
    body: JSON.stringify({ uid: uidA, name: 'Role Test Suite' })
  });
  const suiteData = await suiteRes.json();
  const suiteId = suiteData.suite.id;
  console.log(`[Host] Created suite ${suiteId}`);

  // 2. B and C join the suite
  await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: headers(uidB),
    body: JSON.stringify({ uid: uidB, suiteId })
  });
  await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: headers(uidC),
    body: JSON.stringify({ uid: uidC, suiteId })
  });
  console.log('[Users] B and C joined suite.');

  // 3. A Promotes B
  let res = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidB}`, {
    method: 'POST',
    headers: headers(uidA)
  });
  let body = await res.json();
  if (body.success) console.log('Role Test: HOST promotes MEMBER to ADMIN -> PASS');
  else console.error('Role Test: HOST promotes MEMBER to ADMIN -> FAIL', body);

  // 4. B tries to promote C
  res = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidC}`, {
    method: 'POST',
    headers: headers(uidB)
  });
  body = await res.json();
  if (!body.success && (body.error === 'Only the host can promote admins.' || (body.error || '').includes('host can promote'))) console.log('Role Test: ADMIN promoting MEMBER -> PASS (Blocked)');
  else console.error('Role Test: ADMIN promoting MEMBER -> FAIL', body);

  // 5. C tries to remove B
  res = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidB}`, {
    method: 'DELETE',
    headers: headers(uidC)
  });
  body = await res.json();
  if (!body.success) console.log('Role Test: MEMBER removing ADMIN -> PASS (Blocked)');
  else console.error('Role Test: MEMBER removing ADMIN -> FAIL', body);

  // 6. B removes C (Admin removes Member)
  res = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidC}`, {
    method: 'DELETE',
    headers: headers(uidB)
  });
  body = await res.json();
  if (body.success) console.log('Role Test: ADMIN removing MEMBER -> PASS');
  else console.error('Role Test: ADMIN removing MEMBER -> FAIL', body);

  // 7. B tries to remove A (Admin tries to remove Host)
  res = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidA}`, {
    method: 'DELETE',
    headers: headers(uidB)
  });
  body = await res.json();
  if (!body.success && (body.error === 'Admins cannot remove the host or other admins.' || (body.error || '').includes('cannot be removed') || (body.error || '').includes('cannot remove'))) console.log('Role Test: ADMIN removing HOST -> PASS (Blocked)');
  else console.error('Role Test: ADMIN removing HOST -> FAIL', body);

  // 8. A demotes B
  res = await fetch(`${BASE_URL}/api/suite/${suiteId}/demote/${uidB}`, {
    method: 'POST',
    headers: headers(uidA)
  });
  body = await res.json();
  if (body.success) console.log('Role Test: HOST demotes ADMIN -> PASS');
  else console.error('Role Test: HOST demotes ADMIN -> FAIL', body);

  // 9. Cleanup suite
  await fetch(`${BASE_URL}/api/suites/${suiteId}`, {
    method: 'DELETE',
    headers: headers(uidA)
  });
  console.log('Test completed.');
  process.exit(0);
}

testRoles().catch(console.error);
