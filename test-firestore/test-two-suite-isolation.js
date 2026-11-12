const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') }); } catch (_) {}
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const fetch = require('node-fetch');

const firebaseConfig = {
  apiKey:      process.env.FIREBASE_API_KEY || 'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
  authDomain:  process.env.FIREBASE_AUTH_DOMAIN || 'your-firebase-project-id.firebaseapp.com',
  projectId:   process.env.FIREBASE_PROJECT_ID || 'your-firebase-project-id',
};

const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || 'password123!';

async function testSuiteIsolation() {
  console.log('--- Initializing Two-Suite Isolation Test ---');
  const appA = initializeApp(firebaseConfig, 'appA_iso');
  const appB = initializeApp(firebaseConfig, 'appB_iso');
  const appC = initializeApp(firebaseConfig, 'appC_iso');

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
  console.log(`✓ Authenticated: UserA=${uidA}, UserB=${uidB}, UserC=${uidC}`);

  const BASE_URL = 'http://localhost:3000';
  const authHeaders = (token) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  });

  // Step 1: User A creates Suite 1
  const s1Res = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Suite One Isolation Test', isPrivate: false })
  });
  const s1Data = await s1Res.json();
  const suiteId1 = s1Data.suite.id;
  console.log(`[PASS] Suite 1 created by User A: ${suiteId1}`);

  // Step 2: User B creates Suite 2
  const s2Res = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenB),
    body: JSON.stringify({ name: 'Suite Two Isolation Test', isPrivate: false })
  });
  const s2Data = await s2Res.json();
  const suiteId2 = s2Data.suite.id;
  console.log(`[PASS] Suite 2 created by User B: ${suiteId2}`);

  // Step 3: Verify Suite 1 members endpoint as Host A
  const s1MemRes = await fetch(`${BASE_URL}/api/suite/${suiteId1}/members`, {
    method: 'GET',
    headers: authHeaders(tokenA)
  });
  const s1MemData = await s1MemRes.json();
  console.log(`Suite 1 members according to backend:`, s1MemData.members?.map(m => m.uid));

  if (!s1MemData.members.some(m => m.uid === uidB) && s1MemData.members.some(m => m.uid === uidA)) {
    console.log('[PASS] Suite 1 contains ONLY recorded members (User A), not User B');
  } else {
    console.error('[FAIL] Suite 1 members incorrect!');
    process.exit(1);
  }

  // Step 4: Unauthorized read check: User B tries to read Suite 1 members
  const unauthRes = await fetch(`${BASE_URL}/api/suite/${suiteId1}/members`, {
    method: 'GET',
    headers: authHeaders(tokenB)
  });
  console.log(`Non-member read status: ${unauthRes.status}`);
  if (unauthRes.status === 403) {
    console.log('[PASS] Non-member User B cannot read Suite 1 members (403 Forbidden)');
  } else {
    console.error(`[FAIL] Expected 403, got ${unauthRes.status}`);
    process.exit(1);
  }

  // Step 5: Later-created / non-joined User C tries to read Suite 1 members
  const cUnauthRes = await fetch(`${BASE_URL}/api/suite/${suiteId1}/members`, {
    method: 'GET',
    headers: authHeaders(tokenC)
  });
  if (cUnauthRes.status === 403) {
    console.log('[PASS] Later-created User C cannot read Suite 1 members without joining (403 Forbidden)');
  } else {
    console.error(`[FAIL] Expected 403 for User C, got ${cUnauthRes.status}`);
    process.exit(1);
  }

  // Step 6: User C tries to read Suite 2 members without joining
  const cSuite2UnauthRes = await fetch(`${BASE_URL}/api/suite/${suiteId2}/members`, {
    method: 'GET',
    headers: authHeaders(tokenC)
  });
  if (cSuite2UnauthRes.status === 403) {
    console.log('[PASS] User C cannot read Suite 2 members without joining (403 Forbidden)');
  } else {
    console.error(`[FAIL] Expected 403 for Suite 2, got ${cSuite2UnauthRes.status}`);
    process.exit(1);
  }

  // Step 7: Explicit joining: User C explicitly joins Suite 1
  const joinCRes = await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ suiteId: suiteId1 })
  });
  const joinCData = await joinCRes.json();
  if (joinCData.success) {
    console.log('[PASS] User C explicitly joined Suite 1');
  } else {
    console.error('[FAIL] User C could not join Suite 1:', joinCData);
    process.exit(1);
  }

  // Step 8: Now User C CAN read Suite 1 members
  const cAuthRes = await fetch(`${BASE_URL}/api/suite/${suiteId1}/members`, {
    method: 'GET',
    headers: authHeaders(tokenC)
  });
  const cAuthData = await cAuthRes.json();
  if (cAuthRes.status === 200 && cAuthData.members.some(m => m.uid === uidC)) {
    console.log('[PASS] User C is now an authorized member of Suite 1');
  } else {
    console.error('[FAIL] User C could not read Suite 1 members after joining');
    process.exit(1);
  }

  // Step 9: Verify Suite 2 isolation — User C did NOT join Suite 2, so still cannot read Suite 2
  const cSuite2Res = await fetch(`${BASE_URL}/api/suite/${suiteId2}/members`, {
    method: 'GET',
    headers: authHeaders(tokenC)
  });
  if (cSuite2Res.status === 403) {
    console.log('[PASS] Suite 2 remains isolated from User C (403 Forbidden)');
  } else {
    console.error(`[FAIL] Expected 403 for Suite 2, got ${cSuite2Res.status}`);
    process.exit(1);
  }

  // Cleanup:
  await fetch(`${BASE_URL}/api/suites/${suiteId1}`, { method: 'DELETE', headers: authHeaders(tokenA) });
  await fetch(`${BASE_URL}/api/suites/${suiteId2}`, { method: 'DELETE', headers: authHeaders(tokenB) });
  console.log('🎉 TWO-SUITE ISOLATION TEST PASSED COMPLETELY!');
  process.exit(0);
}

testSuiteIsolation().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
