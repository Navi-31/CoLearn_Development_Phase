const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') }); } catch (_) {}
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, doc, setDoc, addDoc, getDoc, connectFirestoreEmulator } = require('firebase/firestore');

const firebaseConfig = {
  apiKey:      process.env.FIREBASE_API_KEY || 'AIzaSy_DEV_TEST_KEY_PLACEHOLDER',
  authDomain:  process.env.FIREBASE_AUTH_DOMAIN || 'your-firebase-project-id.firebaseapp.com',
  projectId:   process.env.FIREBASE_PROJECT_ID || 'your-firebase-project-id',
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://your-firebase-project-id-default-rtdb.firebaseio.com',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

const uid = () => auth.currentUser ? auth.currentUser.uid : null;

async function getOrCreateUser(email, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    console.log(`Created new user: ${email} (${cred.user.uid})`);
    return cred.user;
  } catch (e) {
    if (e.code === 'auth/email-already-in-use') {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      console.log(`Signed in existing user: ${email} (${cred.user.uid})`);
      return cred.user;
    }
    throw e;
  }
}

async function runTests() {
  try {
    // 1. Create or login users A, B, C
    const userA = await getOrCreateUser('testA_host@example.com', 'password123!');
    const uidA = userA.uid;
    
    // We need 3 separate apps to simulate 3 different users simultaneously
    const appB = initializeApp(firebaseConfig, 'appB');
    const authB = getAuth(appB);
    const dbB = getFirestore(appB);
    connectFirestoreEmulator(dbB, '127.0.0.1', 8080);
    let userB;
    try { userB = await createUserWithEmailAndPassword(authB, 'testB_admin@example.com', 'password123!'); }
    catch (e) { userB = await signInWithEmailAndPassword(authB, 'testB_admin@example.com', 'password123!'); }
    const uidB = userB.user.uid;
    
    const appC = initializeApp(firebaseConfig, 'appC');
    const authC = getAuth(appC);
    const dbC = getFirestore(appC);
    connectFirestoreEmulator(dbC, '127.0.0.1', 8080);
    let userC;
    try { userC = await createUserWithEmailAndPassword(authC, 'testC_member@example.com', 'password123!'); }
    catch (e) { userC = await signInWithEmailAndPassword(authC, 'testC_member@example.com', 'password123!'); }
    const uidC = userC.user.uid;

    console.log(`UIDs: A=${uidA}, B=${uidB}, C=${uidC}`);

    // 2. A creates suite
    const suiteId = 'test_suite_' + Date.now();
    const suiteRef = doc(db, 'suites', suiteId);
    console.log('A is creating suite: ' + suiteId);
    await setDoc(suiteRef, {
      ownerUid: uidA,
      name: 'Test Suite',
      memberUids: [uidA, uidB, uidC],
      adminUids: [uidB]
    });
    console.log('Suite created successfully by A.');

    // 3. Test Group Chat Messages
    console.log('--- Testing Group Chat ---');
    try {
      await addDoc(collection(db, 'suites', suiteId, 'messages'), { senderUid: uidA, text: 'Hello from Host' });
      console.log('Group Chat: A (Host) sending -> PASS');
    } catch (e) { console.error('Group Chat: A (Host) sending -> FAIL', e.code); }

    try {
      await addDoc(collection(dbB, 'suites', suiteId, 'messages'), { senderUid: uidB, text: 'Hello from Admin' });
      console.log('Group Chat: B (Admin) sending -> PASS');
    } catch (e) { console.error('Group Chat: B (Admin) sending -> FAIL', e.code); }

    try {
      await addDoc(collection(dbC, 'suites', suiteId, 'messages'), { senderUid: uidC, text: 'Hello from Member' });
      console.log('Group Chat: C (Member) sending -> PASS');
    } catch (e) { console.error('Group Chat: C (Member) sending -> FAIL', e.message); }

    // 4. Test Private Chat Messages
    console.log('--- Testing Private Chat ---');
    // A to C
    const convIdAC = uidA < uidC ? `${uidA}_${uidC}` : `${uidC}_${uidA}`;
    try {
      await setDoc(doc(db, 'privateChats', convIdAC), { participants: [uidA, uidC] }, { merge: true });
      await addDoc(collection(db, 'privateChats', convIdAC, 'messages'), { senderUid: uidA, text: 'Private A to C' });
      console.log('Private Chat: A to C -> PASS');
    } catch(e) { console.error('Private Chat: A to C -> FAIL', e.message); }

    // B to C
    const convIdBC = uidB < uidC ? `${uidB}_${uidC}` : `${uidC}_${uidB}`;
    try {
      await setDoc(doc(dbB, 'privateChats', convIdBC), { participants: [uidB, uidC] }, { merge: true });
      await addDoc(collection(dbB, 'privateChats', convIdBC, 'messages'), { senderUid: uidB, text: 'Private B to C' });
      console.log('Private Chat: B to C -> PASS');
    } catch(e) { console.error('Private Chat: B to C -> FAIL', e.message); }

    // C to A
    try {
      await addDoc(collection(dbC, 'privateChats', convIdAC, 'messages'), { senderUid: uidC, text: 'Private C to A' });
      console.log('Private Chat: C to A -> PASS');
    } catch(e) { console.error('Private Chat: C to A -> FAIL', e.message); }

    // Verify 3rd member cannot read private chat
    try {
      const convIdAB = uidA < uidB ? `${uidA}_${uidB}` : `${uidB}_${uidA}`;
      await setDoc(doc(db, 'privateChats', convIdAB), { participants: [uidA, uidB] }, { merge: true });
      
      const testDoc = await getDoc(doc(dbC, 'privateChats', convIdAB));
      console.error('Private Chat: C reading A-B -> FAIL (Should have thrown permission denied)');
    } catch (e) {
      if (e.code === 'permission-denied') {
        console.log('Private Chat: C reading A-B -> PASS (Permission denied as expected)');
      } else {
        console.error('Private Chat: C reading A-B -> Unknown Error', e.message);
      }
    }

  } catch (err) {
    console.error('Test script failed:', err);
  } finally {
    process.exit(0);
  }
}

runTests();
