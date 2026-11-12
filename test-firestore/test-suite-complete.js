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

async function runComprehensiveTests() {
  console.log('--- 1. Authenticating Host (A), Admin/User (B), Member/User (C) with Firebase Auth ---');
  const appA = initializeApp(firebaseConfig, 'appA');
  const appB = initializeApp(firebaseConfig, 'appB');
  const appC = initializeApp(firebaseConfig, 'appC');

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
  console.log(`✓ Authenticated: Host=${uidA}, UserB=${uidB}, UserC=${uidC}`);

  const BASE_URL = 'http://localhost:3000';
  const authHeaders = (token) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  });

  let allPassed = true;
  let totalTests = 0, passedTests = 0;
  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`[PASS] ${message}`);
    } else {
      console.error(`[FAIL] ${message}`);
      allPassed = false;
    }
  }

  // --- TEST SUITE CREATION WITH ADMIN COUNTER ---
  console.log('\n--- 2. Suite Creation & Admin Limit Counter ---');
  // Attempt invalid admin limit (e.g. 0)
  let createRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Invalid Limit Suite', adminLimit: 0 })
  });
  let createData = await createRes.json();
  assert(!createData.success, 'Reject adminLimit < 1 on creation');

  // Attempt excessive admin limit (e.g. 25)
  createRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Excessive Limit Suite', adminLimit: 25 })
  });
  createData = await createRes.json();
  assert(!createData.success, 'Reject adminLimit > 20 on creation');

  // Create valid suite with adminLimit: 1
  createRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Admin Limit Suite', adminLimit: 1 })
  });
  createData = await createRes.json();
  const suiteId = createData.suite?.id;
  assert(createData.success && createData.suite.adminLimit === 1, 'Create suite with adminLimit: 1');
  assert(createData.suite.ownerUid === uidA || createData.suite.hostUid === uidA, 'Creator is HOST and owner');

  // --- TEST JOINING & PROMOTION AT ADMIN LIMIT ---
  console.log('\n--- 3. Member Join & Admin Limit Enforcement ---');
  // B & C join
  let joinResB = await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: authHeaders(tokenB),
    body: JSON.stringify({ suiteId })
  });
  let joinDataB = await joinResB.json();
  console.log(`  B join response: ${JSON.stringify(joinDataB)}`);

  let joinResC = await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ suiteId })
  });
  let joinDataC = await joinResC.json();
  console.log(`  C join response: ${JSON.stringify(joinDataC)}`);

  // Verify members list
  let memRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members`, {
    method: 'GET',
    headers: authHeaders(tokenA)
  });
  let memData = await memRes.json();
  console.log(`  Members: ${JSON.stringify(memData.members?.map(m => m.uid))}`);

  // Host promotes B to Admin (count: 1 / 1 allowed)
  let promoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidB}`, {
    method: 'POST',
    headers: authHeaders(tokenA)
  });
  let promoteData = await promoteRes.json();
  console.log(`  Promote B response: ${JSON.stringify(promoteData)}`);
  assert(promoteData.success, 'Host promotes Member B to Admin (1/1)');

  // Host attempts to promote C (would exceed limit of 1)
  promoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidC}`, {
    method: 'POST',
    headers: authHeaders(tokenA)
  });
  promoteData = await promoteRes.json();
  console.log(`  Promote C at limit response: ${JSON.stringify(promoteData)}`);
  assert(!promoteData.success && (promoteData.error || '').includes('Admin limit reached'), 'Promotion blocked when at admin limit');

  // Non-host (Admin B) attempts promotion
  promoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidC}`, {
    method: 'POST',
    headers: authHeaders(tokenB)
  });
  promoteData = await promoteRes.json();
  assert(!promoteData.success && (promoteData.error || '').includes('Only the suite host'), 'Admin B blocked from promoting');

  // --- TEST SUITE SETTINGS & ADMIN LIMIT ADJUSTMENTS ---
  console.log('\n--- 4. Suite Settings & Admin Limit Adjustments ---');
  // Member C tries to change settings
  let settRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ name: 'Hacked Name', adminLimit: 5 })
  });
  let settData = await settRes.json();
  assert(!settData.success && (settData.error || '').includes('Only the suite host'), 'Member C blocked from editing suite settings');

  // Admin B tries to change settings
  settRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(tokenB),
    body: JSON.stringify({ name: 'Admin Edit Name', adminLimit: 5 })
  });
  settData = await settRes.json();
  assert(!settData.success && (settData.error || '').includes('Only the suite host'), 'Admin B blocked from editing suite settings');

  // Host tries to lower adminLimit below current admin count (lowering to 0 when 1 admin exists)
  settRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ adminLimit: 0 })
  });
  settData = await settRes.json();
  assert(!settData.success, 'Blocking adminLimit reduction below minimum or current admin count');

  // Host increases adminLimit to 2
  settRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Expanded Suite', adminLimit: 2 })
  });
  settData = await settRes.json();
  assert(settData.success && settData.suite.adminLimit === 2 && settData.suite.name === 'Expanded Suite', 'Host successfully updates suite name and adminLimit to 2');

  // Host can now promote Member C (count: 2 / 2 allowed)
  promoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/promote/${uidC}`, {
    method: 'POST',
    headers: authHeaders(tokenA)
  });
  promoteData = await promoteRes.json();
  console.log(`  Promote C after expansion: ${JSON.stringify(promoteData)}`);
  assert(promoteData.success, 'Host promotes Member C to Admin after limit expansion (2/2)');

  // Now with 2 admins (B and C), try lowering adminLimit to 1
  settRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/settings`, {
    method: 'PATCH',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ adminLimit: 1 })
  });
  settData = await settRes.json();
  console.log(`  Lower limit response: ${JSON.stringify(settData)}`);
  assert(!settData.success && (settData.error || '').includes('emote'), 'Blocked reducing adminLimit to 1 when 2 admins exist');

  // Host demotes C back to member
  let demoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/demote/${uidC}`, {
    method: 'POST',
    headers: authHeaders(tokenA)
  });
  let demoteData = await demoteRes.json();
  console.log(`  Demote C response: ${JSON.stringify(demoteData)}`);
  assert(demoteData.success, 'Host demotes Admin C to Member');

  // Admin B tries to demote Host A
  demoteRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/demote/${uidA}`, {
    method: 'POST',
    headers: authHeaders(tokenB)
  });
  demoteData = await demoteRes.json();
  assert(!demoteData.success && (demoteData.error || '').includes('Only the'), 'Admin B blocked from demoting Host');

  // --- TEST REMOVAL RULES ---
  console.log('\n--- 5. Member Removal Hierarchy ---');
  // Re-add C (was demoted, still in suite)
  // Check C is still a member:
  memRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members`, {
    method: 'GET',
    headers: authHeaders(tokenA)
  });
  memData = await memRes.json();
  console.log(`  Members before removals: ${JSON.stringify(memData.members?.map(m => ({uid:m.uid, role:m.role})))}`);

  // Admin B removes Member C
  let delRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidC}`, {
    method: 'DELETE',
    headers: authHeaders(tokenB)
  });
  let delData = await delRes.json();
  console.log(`  B removes C response: ${JSON.stringify(delData)}`);
  assert(delData.success, 'Admin B removes Member C');

  // Admin B tries to remove Host A
  delRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidA}`, {
    method: 'DELETE',
    headers: authHeaders(tokenB)
  });
  delData = await delRes.json();
  console.log(`  B removes A response: ${JSON.stringify(delData)}`);
  assert(!delData.success && (delData.error || '').includes('cannot'), 'Admin B blocked from removing Host A');

  // Host tries to remove themselves
  delRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidA}`, {
    method: 'DELETE',
    headers: authHeaders(tokenA)
  });
  delData = await delRes.json();
  console.log(`  A removes self response: ${JSON.stringify(delData)}`);
  assert(!delData.success && (delData.error || '').includes('cannot remove themselves'), 'Host blocked from removing themselves');

  // Host removes Admin B
  delRes = await fetch(`${BASE_URL}/api/suite/${suiteId}/members/${uidB}`, {
    method: 'DELETE',
    headers: authHeaders(tokenA)
  });
  delData = await delRes.json();
  console.log(`  A removes B response: ${JSON.stringify(delData)}`);
  assert(delData.success, 'Host removes Admin B');

  // Clean up suite 1
  await fetch(`${BASE_URL}/api/suites/${suiteId}`, {
    method: 'DELETE',
    headers: authHeaders(tokenA)
  });

  // --- TEST PRIVATE SUITE JOIN REQUESTS ---
  console.log('\n--- 6. Private Suite Join Request Workflow ---');
  // Host creates a PRIVATE suite
  createRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Secret Private Suite', isPrivate: true, adminLimit: 3 })
  });
  createData = await createRes.json();
  const privSuiteId = createData.suite?.id;
  assert(createData.success && createData.suite.isPrivate, 'Created private suite');

  // Member C requests to join private suite (via /api/suite/join which creates request for private suites)
  let joinReqRes = await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ suiteId: privSuiteId })
  });
  let joinReqData = await joinReqRes.json();
  console.log(`  C join private response: ${JSON.stringify(joinReqData)}`);
  assert(joinReqData.success && joinReqData.pending, 'Member C creates pending join request');
  const requestId = joinReqData.requestId;

  // Duplicate request check
  let dupReqRes = await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ suiteId: privSuiteId })
  });
  let dupReqData = await dupReqRes.json();
  console.log(`  Dup join response: ${JSON.stringify(dupReqData)}`);
  assert(dupReqData.success && dupReqData.pending, 'Duplicate join request returns pending status');

  // Host lists pending requests
  let listReqRes = await fetch(`${BASE_URL}/api/suite/${privSuiteId}/join-requests`, {
    method: 'GET',
    headers: authHeaders(tokenA)
  });
  let listReqData = await listReqRes.json();
  console.log(`  Join requests list: ${JSON.stringify(listReqData.requests?.map(r => r.requesterUid))}`);
  assert(listReqData.success && listReqData.requests?.length >= 1 && listReqData.requests.some(r => r.requesterUid === uidC), 'Host retrieves pending join request');

  // Get the actual request ID from the list (more reliable)
  const actualRequestId = listReqData.requests?.find(r => r.requesterUid === uidC)?.id || requestId;

  // Host approves request
  let approveRes = await fetch(`${BASE_URL}/api/suite/${privSuiteId}/join-requests/${actualRequestId}/approve`, {
    method: 'POST',
    headers: authHeaders(tokenA)
  });
  let approveData = await approveRes.json();
  console.log(`  Approve response: ${JSON.stringify(approveData)}`);
  assert(approveData.success, 'Host approves join request');

  // Verify Member C is now a suite member
  let memCheckRes = await fetch(`${BASE_URL}/api/suite/${privSuiteId}/members`, {
    method: 'GET',
    headers: authHeaders(tokenA)
  });
  let memCheckData = await memCheckRes.json();
  const isCNowMember = memCheckData.members?.some(m => m.uid === uidC);
  assert(isCNowMember, 'Approved requester C is now in suite member list');

  // Clean up private suite
  await fetch(`${BASE_URL}/api/suites/${privSuiteId}`, {
    method: 'DELETE',
    headers: authHeaders(tokenA)
  });

  // --- TEST DIRECT API SECURITY / FORGED IDENTITY ---
  console.log('\n--- 7. Identity & Token Security Verification ---');
  // Request with invalid token
  let badTokenRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid.forged.token' },
    body: JSON.stringify({ name: 'Forged Suite' })
  });
  assert(badTokenRes.status === 401, 'Reject invalid Bearer token with 401');

  // Request attempting to impersonate another user in body
  let spoofRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenC),
    body: JSON.stringify({ name: 'Spoofed Suite', uid: uidA }) // Token is C, but body says A
  });
  let spoofData = await spoofRes.json();
  // req.verifiedUid from token should take precedence
  const suiteOwner = spoofData.suite?.ownerUid || spoofData.suite?.hostUid;
  console.log(`  Spoof result: owner=${suiteOwner}, expected=${uidC}`);
  assert(spoofData.success && suiteOwner === uidC, 'Verified UID from token enforced; body spoofing ignored');

  // Clean up spoofed suite
  if (spoofData.suite?.id) {
    await fetch(`${BASE_URL}/api/suites/${spoofData.suite.id}`, {
      method: 'DELETE',
      headers: authHeaders(tokenC)
    });
  }

  // --- MEMBER C CANNOT REMOVE ---
  console.log('\n--- 8. Member Cannot Remove Anyone ---');
  createRes = await fetch(`${BASE_URL}/api/suites`, {
    method: 'POST',
    headers: authHeaders(tokenA),
    body: JSON.stringify({ name: 'Permission Test Suite', adminLimit: 3 })
  });
  createData = await createRes.json();
  const permSuiteId = createData.suite?.id;
  
  await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST', headers: authHeaders(tokenB), body: JSON.stringify({ suiteId: permSuiteId })
  });
  await fetch(`${BASE_URL}/api/suite/join`, {
    method: 'POST', headers: authHeaders(tokenC), body: JSON.stringify({ suiteId: permSuiteId })
  });

  // Member C tries to remove B
  delRes = await fetch(`${BASE_URL}/api/suite/${permSuiteId}/members/${uidB}`, {
    method: 'DELETE',
    headers: authHeaders(tokenC)
  });
  delData = await delRes.json();
  assert(!delData.success, 'Member C blocked from removing Member B');

  // Member C tries to promote
  promoteRes = await fetch(`${BASE_URL}/api/suite/${permSuiteId}/promote/${uidB}`, {
    method: 'POST',
    headers: authHeaders(tokenC)
  });
  promoteData = await promoteRes.json();
  assert(!promoteData.success, 'Member C blocked from promoting');

  // Cleanup
  await fetch(`${BASE_URL}/api/suites/${permSuiteId}`, {
    method: 'DELETE',
    headers: authHeaders(tokenA)
  });

  console.log(`\n=============================================`);
  console.log(`Results: ${passedTests}/${totalTests} tests passed`);
  if (allPassed) {
    console.log('🎉 ALL INTEGRATION AND SECURITY TESTS PASSED!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runComprehensiveTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
