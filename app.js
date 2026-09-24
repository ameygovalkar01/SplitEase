import { firebaseApp } from "./firebase-config.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, onSnapshot, getDocs, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
let me = null;          // Firebase auth user
let myProfile = null;   // Firestore users/{uid} doc data
let myGroup = null;     // { id, ...data }
let groupMembers = {};  // { uid: {name, photoUrl, upiQrUrl} }
let myExpenses = {};    // { expenseId: data } — only ones I can see
let myPayments = {};    // { paymentId: data } — only ones involving me
let unsubExpensesA, unsubExpensesB, unsubPaymentsA, unsubPaymentsB, unsubGroup;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const authScreen = $("authScreen");
const groupGateScreen = $("groupGateScreen");
const appScreen = $("appScreen");

// ================= AUTH =================
$("googleSignInBtn").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert("Sign-in failed: " + e.message);
  }
};

$("signOutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  me = user;
  cleanupListeners();
  if (!user) {
    show(authScreen); hide(groupGateScreen); hide(appScreen);
    return;
  }

  // Create/refresh user profile
  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    myProfile = {
      name: user.displayName || "Unnamed",
      email: user.email || "",
      photoUrl: user.photoURL || "",
      upiQrUrl: null,
      groupId: null
    };
    await setDoc(userRef, myProfile);
  } else {
    myProfile = snap.data();
  }

  // Load all groups this user belongs to
  await loadAndShowGroups();
});

// ================= MULTI-GROUP MANAGEMENT =================
async function loadAndShowGroups() {
  cleanupListeners();
  hide(authScreen);
  hide(appScreen);
  show(groupGateScreen);

  const q = query(collection(db, "groups"), where("memberIds", "array-contains", me.uid));
  const myGroupsDocs = await getDocsOnce(q);

  const section = $("myGroupsSection");
  const list = $("myGroupsList");

  if (myGroupsDocs.length > 0) {
    if (section) show(section);
    if (list) {
      list.innerHTML = myGroupsDocs.map(g => `
        <div class="balance-row owed" style="cursor:pointer; margin-bottom:8px;" onclick="window.enterGroup('${g.id}')">
          <div>
            <div class="balance-person"><strong>${escapeHTML(g.data.name)}</strong></div>
            <div class="balance-status" style="margin:0">Code: ${g.data.code}</div>
          </div>
          <div style="text-align:right">
            <button class="btn-small">Open &rarr;</button>
          </div>
        </div>
      `).join("");
    }
  } else {
    if (section) hide(section);
    if (list) list.innerHTML = "";
  }
}

// Global click listener for My Groups button
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "switchGroupBtn") {
    e.preventDefault();
    loadAndShowGroups();
  }
});

// ================= GROUP GATE =================
$("createGroupBtn").onclick = async () => {
  const name = $("newGroupNameInput").value.trim();
  if (!name) return alert("Enter a group name.");
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  const groupRef = await addDoc(collection(db, "groups"), {
    name, code, memberIds: [me.uid], createdBy: me.uid, createdAt: Date.now()
  });

  $("newGroupNameInput").value = "";
  await enterGroup(groupRef.id);
};

$("joinGroupBtn").onclick = async () => {
  const code = $("joinCodeInput").value.trim();
  if (!code) return alert("Enter the group code.");

  const q = query(collection(db, "groups"), where("code", "==", code));
  const results = await getDocsOnce(q);
  if (results.length === 0) return alert("No group found with that code.");

  const groupDoc = results[0];
  // arrayUnion is atomic server-side — safe even if two people join at once,
  // unlike re-writing the whole array from a locally-read copy.
  await updateDoc(doc(db, "groups", groupDoc.id), {
    memberIds: arrayUnion(me.uid)
  });

  $("joinCodeInput").value = "";
  await enterGroup(groupDoc.id);
};

// one-off query helper (onSnapshot not needed for a single read)
async function getDocsOnce(q) {
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, data: d.data() }));
}

// ================= ENTER GROUP =================
window.enterGroup = async function enterGroup(groupId) {
  cleanupListeners(); // Prevents cross-group memory leaks and mixed balances

  const groupRef = doc(db, "groups", groupId);
  const groupSnap = await getDoc(groupRef);
  if (!groupSnap.exists()) {
    await loadAndShowGroups();
    return;
  }
  myGroup = { id: groupId, ...groupSnap.data() };

  hide(authScreen); hide(groupGateScreen); show(appScreen);

  $("userPhoto").src = myProfile.photoUrl || "";
  $("userNameLabel").textContent = myProfile.name;
  $("groupNameLabel").textContent = myGroup.name;

  await loadGroupMembers();
  listenToGroup(groupId);
  listenToMyExpenses();
  listenToMyPayments();
};

async function loadGroupMembers() {
  groupMembers = {};
  for (const uid of myGroup.memberIds) {
    const s = await getDoc(doc(db, "users", uid));
    if (s.exists()) groupMembers[uid] = s.data();
  }
  renderPayerAndSplitOptions();
}

// Keep the group doc (and any newly-joined members) live, so if a friend
// joins mid-session they immediately show up in "Paid By" / "Split Between".
function listenToGroup(groupId) {
  const groupRef = doc(db, "groups", groupId);
  unsubGroup = onSnapshot(groupRef, async (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    myGroup = { id: groupId, ...data };
    $("groupNameLabel").textContent = myGroup.name;

    const newIds = data.memberIds.filter(uid => !groupMembers[uid]);
    if (newIds.length > 0) {
      for (const uid of newIds) {
        const s = await getDoc(doc(db, "users", uid));
        if (s.exists()) groupMembers[uid] = s.data();
      }
      renderPayerAndSplitOptions();
    }
  });
}

// ================= EXPENSES (privacy: I only query docs where I'm payer or in splitWith) =================
function listenToMyExpenses() {
  const col = collection(db, "expenses");
  const qA = query(col, where("groupId", "==", myGroup.id), where("payerId", "==", me.uid));
  const qB = query(col, where("groupId", "==", myGroup.id), where("splitWith", "array-contains", me.uid));

  unsubExpensesA = onSnapshot(qA, (snap) => { mergeExpenses(snap); renderAll(); });
  unsubExpensesB = onSnapshot(qB, (snap) => { mergeExpenses(snap); renderAll(); });
}
function mergeExpenses(snap) {
  snap.docChanges().forEach((change) => {
    if (change.type === "removed") delete myExpenses[change.doc.id];
    else myExpenses[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
  });
}

function listenToMyPayments() {
  const col = collection(db, "payments");
  const qA = query(col, where("groupId", "==", myGroup.id), where("fromUserId", "==", me.uid));
  const qB = query(col, where("groupId", "==", myGroup.id), where("toUserId", "==", me.uid));

  unsubPaymentsA = onSnapshot(qA, (snap) => { mergePayments(snap); renderAll(); });
  unsubPaymentsB = onSnapshot(qB, (snap) => { mergePayments(snap); renderAll(); });
}
function mergePayments(snap) {
  snap.docChanges().forEach((change) => {
    if (change.type === "removed") delete myPayments[change.doc.id];
    else myPayments[change.doc.id] = { id: change.doc.id, ...change.doc.data() };
  });
}

function cleanupListeners() {
  [unsubExpensesA, unsubExpensesB, unsubPaymentsA, unsubPaymentsB, unsubGroup].forEach(u => u && u());
  unsubExpensesA = unsubExpensesB = unsubPaymentsA = unsubPaymentsB = unsubGroup = undefined;
  myExpenses = {}; myPayments = {}; myGroup = null; groupMembers = {};
}

// ================= ADD EXPENSE =================
function renderPayerAndSplitOptions() {
  const payerSelect = $("expPayer");
  payerSelect.innerHTML = Object.entries(groupMembers)
    .map(([uid, p]) => `<option value="${uid}">${escapeHTML(p.name)}${uid === me.uid ? " (you)" : ""}</option>`)
    .join("");

  const splitBox = $("splitCheckboxes");
  splitBox.innerHTML = Object.entries(groupMembers).map(([uid, p]) => `
    <label class="check-item">
      <input type="checkbox" class="split-cb" value="${uid}" checked>
      <span>${escapeHTML(p.name)}${uid === me.uid ? " (you)" : ""}</span>
    </label>
  `).join("");
}

$("addExpenseBtn").onclick = async () => {
  const desc = $("expDesc").value.trim();
  const amountVal = parseFloat($("expAmount").value);
  const payerId = $("expPayer").value;
  const splitWith = Array.from(document.querySelectorAll(".split-cb:checked")).map(cb => cb.value);

  if (!desc) return alert("Enter a description.");
  if (isNaN(amountVal) || amountVal <= 0) return alert("Enter a valid positive amount.");
  if (splitWith.length === 0) return alert("Select at least one person to split with.");

  const addBtn = $("addExpenseBtn");
  addBtn.disabled = true;
  try {
    await addDoc(collection(db, "expenses"), {
      groupId: myGroup.id,
      desc,
      amountInCents: Math.round(amountVal * 100),
      payerId,
      splitWith,
      createdAt: Date.now()
    });
    $("expDesc").value = "";
    $("expAmount").value = "";
    renderPayerAndSplitOptions(); // resets checkboxes back to all-checked
  } catch (e) {
    alert("Couldn't add expense: " + e.message);
  } finally {
    addBtn.disabled = false;
  }
};

window.deleteExpense = async (id) => {
  if (!confirm("Delete this expense?")) return;
  try {
    await deleteDoc(doc(db, "expenses", id));
  } catch (e) {
    alert("Couldn't delete: " + e.message);
  }
};

// ================= BALANCE CALCULATION (pairwise, privacy-safe) =================
// Only uses expenses I can already see (I'm payer or in splitWith) — so this
// never requires seeing anyone else's unrelated expenses.
function computeBalances() {
  const expenseBalance = {}; // uid -> cents. positive = they owe me. negative = I owe them.

  Object.values(myExpenses).forEach(exp => {
    const n = exp.splitWith.length;
    const share = Math.floor(exp.amountInCents / n);
    const remainder = exp.amountInCents % n;

    exp.splitWith.forEach((uid, idx) => {
      let personShare = share + (idx < remainder ? 1 : 0);
      if (exp.payerId === me.uid && uid !== me.uid) {
        expenseBalance[uid] = (expenseBalance[uid] || 0) + personShare; // they owe me
      }
      if (uid === me.uid && exp.payerId !== me.uid) {
        expenseBalance[exp.payerId] = (expenseBalance[exp.payerId] || 0) - personShare; // I owe payer
      }
    });
  });

  // Net out confirmed payments
  const netPayments = {};
  Object.values(myPayments).forEach(p => {
    if (p.status !== "confirmed") return;
    if (p.fromUserId === me.uid) netPayments[p.toUserId] = (netPayments[p.toUserId] || 0) - p.amountInCents;
    if (p.toUserId === me.uid) netPayments[p.fromUserId] = (netPayments[p.fromUserId] || 0) + p.amountInCents;
  });

  const balances = {};
  const allIds = new Set([...Object.keys(expenseBalance), ...Object.keys(netPayments)]);
  allIds.forEach(uid => {
    balances[uid] = (expenseBalance[uid] || 0) - (netPayments[uid] || 0);
  });

  return balances;
}

function pendingPaymentWith(otherUid, direction) {
  // direction: "outgoing" = I paid them, waiting on their confirmation
  //            "incoming" = they paid me, waiting on my confirmation
  return Object.values(myPayments).find(p =>
    p.status === "pending" &&
    (direction === "outgoing" ? p.fromUserId === me.uid && p.toUserId === otherUid
                               : p.toUserId === me.uid && p.fromUserId === otherUid)
  );
}

// ================= RENDER =================
function renderAll() {
  renderBalances();
  renderExpenseList();
}

function renderBalances() {
  const balances = computeBalances();
  const wrap = $("balancesList");
  const entries = Object.entries(balances).filter(([, cents]) => Math.abs(cents) >= 1);

  if (entries.length === 0) {
    wrap.innerHTML = '<p class="empty-state">All settled up!</p>';
    return;
  }

  wrap.innerHTML = entries.map(([uid, cents]) => {
    const person = groupMembers[uid];
    const name = person ? escapeHTML(person.name) : "Unknown";
    const rupees = (Math.abs(cents) / 100).toFixed(2);

    if (cents < 0) {
      // I owe them
      const pending = pendingPaymentWith(uid, "outgoing");
      const rejected = Object.values(myPayments).find(p =>
        p.status === "rejected" && p.fromUserId === me.uid && p.toUserId === uid
      );

      return `
        <div class="balance-row owe">
          <div>
            <div class="balance-person">You owe ${name}</div>
            ${pending ? '<div class="balance-status">Payment submitted — waiting for confirmation</div>' : ""}
            ${!pending && rejected ? '<div class="balance-status" style="color:#ef4444">Previous payment was rejected. Please pay again.</div>' : ""}
          </div>
          <div style="text-align:right">
            <div class="balance-amt owe">₹${rupees}</div>
            ${!pending ? `<button class="btn-small" onclick="openPayModal('${uid}',${Math.abs(cents)})">Pay</button>` : ""}
          </div>
        </div>`;
    } else {
      const pending = pendingPaymentWith(uid, "incoming");
      return `
        <div class="balance-row owed">
          <div>
            <div class="balance-person">${name} owes you</div>
            ${pending ? '<div class="balance-status">They marked this as paid — review it</div>' : ""}
          </div>
          <div style="text-align:right">
            <div class="balance-amt owed">₹${rupees}</div>
            ${pending ? `<button class="btn-small" onclick="openConfirmModal('${pending.id}')">Review</button>` : ""}
          </div>
        </div>`;
    }
  }).join("");
}

function renderExpenseList() {
  const list = $("expenseList");
  const items = Object.values(myExpenses).sort((a, b) => b.createdAt - a.createdAt);

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-state">No expenses yet.</p>';
    return;
  }

  list.innerHTML = items.map(exp => {
    const payerName = groupMembers[exp.payerId]?.name || "Unknown";
    const canDelete = exp.payerId === me.uid;
    return `
      <li class="expense-item">
        <div>
          <div><strong>${escapeHTML(exp.desc)}</strong></div>
          <div class="exp-meta">Paid by ${escapeHTML(payerName)} • Split with ${exp.splitWith.length}</div>
        </div>
        <div style="display:flex; align-items:center; gap:12px">
          <span class="exp-amt">₹${(exp.amountInCents / 100).toFixed(2)}</span>
          ${canDelete ? `<button class="remove-btn" onclick="deleteExpense('${exp.id}')">&times;</button>` : ""}
        </div>
      </li>`;
  }).join("");
}

// ================= QR CODE UPLOAD (my own profile) =================
$("uploadQrBtn").onclick = () => $("qrFileInput").click();
$("qrFileInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const url = await imageToDataUrl(file, 700, 0.85);
    await updateDoc(doc(db, "users", me.uid), { upiQrUrl: url });
    myProfile.upiQrUrl = url;
    groupMembers[me.uid] = { ...groupMembers[me.uid], upiQrUrl: url };
    alert("QR code updated!");
  } catch (err) {
    alert("Couldn't upload QR: " + err.message);
  } finally {
    e.target.value = "";
  }
};

// ================= PAY MODAL =================
let payModalTargetUid = null;
let payModalAmountCents = 0;

window.openPayModal = (uid, cents) => {
  payModalTargetUid = uid;
  payModalAmountCents = cents;
  const person = groupMembers[uid];
  $("payModalTitle").textContent = `Pay ${person?.name || ""} ₹${(cents / 100).toFixed(2)}`;
  if (person?.upiQrUrl) {
    $("payModalQrWrap").classList.remove("hidden");
    $("payModalQrImg").src = person.upiQrUrl;
  } else {
    $("payModalQrWrap").classList.add("hidden");
  }
  $("proofFileInput").value = "";
  show($("payModal"));
};
$("closePayModalBtn").onclick = () => hide($("payModal"));

$("submitProofBtn").onclick = async () => {
  const btn = $("submitProofBtn");
  btn.disabled = true;
  try {
    const file = $("proofFileInput").files[0];
    let proofUrl = null;

    if (file) {
      proofUrl = await imageToDataUrl(file, 800, 0.7);
    }

    await addDoc(collection(db, "payments"), {
      groupId: myGroup.id,
      fromUserId: me.uid,
      toUserId: payModalTargetUid,
      amountInCents: Math.round(Number(payModalAmountCents)),
      proofUrl,
      status: "pending",
      createdAt: Date.now()
    });

    hide($("payModal"));
  } catch (e) {
    alert("Couldn't submit payment: " + e.message);
  } finally {
    btn.disabled = false;
  }
};

// ================= CONFIRM MODAL =================
window.openConfirmModal = (paymentId) => {
  const p = myPayments[paymentId];
  if (!p) return;
  const payer = groupMembers[p.fromUserId];
  $("confirmModalTitle").textContent = `${payer?.name || "Someone"} paid ₹${(p.amountInCents / 100).toFixed(2)}`;
  $("confirmModalProofImg").src = p.proofUrl || "";
  $("confirmModalProofImg").classList.toggle("hidden", !p.proofUrl);

  $("confirmPaymentBtn").onclick = async () => {
    try {
      await updateDoc(doc(db, "payments", paymentId), { status: "confirmed" });
      hide($("confirmModal"));
    } catch (e) {
      alert("Couldn't confirm: " + e.message);
    }
  };

  const rejectBtn = $("rejectPaymentBtn");
  if (rejectBtn) {
    rejectBtn.onclick = async () => {
      if (!confirm("Reject this payment? The sender will be asked to pay again.")) return;
      try {
        await updateDoc(doc(db, "payments", paymentId), { status: "rejected" });
        hide($("confirmModal"));
      } catch (e) {
        alert("Couldn't reject: " + e.message);
      }
    };
  }

  show($("confirmModal"));
};
$("closeConfirmModalBtn").onclick = () => hide($("confirmModal"));

// ================= INVITE MODAL =================
$("inviteBtn").onclick = () => {
  $("inviteCodeDisplay").textContent = myGroup.code;
  show($("inviteModal"));
};
$("closeInviteModalBtn").onclick = () => hide($("inviteModal"));

// ================= HELPERS =================
async function imageToDataUrl(file, maxSide, quality) {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  let q = quality;
  let dataUrl = canvas.toDataURL("image/jpeg", q);
  while (dataUrl.length > 180000 && q > 0.2) {
    q -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", q);
  }
  if (dataUrl.length > 400000) throw new Error("Image is too large, try a smaller one.");
  return dataUrl;
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
function escapeHTML(str) {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML;
}