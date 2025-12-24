import { ADMIN_EMAIL, firebaseConfig } from "./config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-storage.js";

/* ---------- Init ---------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach(t=>{
  t.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    const tab = t.dataset.tab;
    document.querySelectorAll(".panel").forEach(p=>p.style.display="none");
    const panel = $(tab);
    if (panel) panel.style.display="block";

    renderSolvePicker();
    renderQuestionPicker();
    renderCategoryBuilder();
  });
});

/* ---------- State ---------- */
let currentUser = null;
let categories = [];
let quizzes = [];
let questions = [];

// Ctrl+V upload bekleyen görsel
let pendingImage = { imageUrl: "", storagePath: "" };

// Solve picker state
let selectedLessonId = "";
let selectedTopicId  = "";
let selectedQuizId   = "";

// Question picker state
let qSelectedLessonId = "";
let qSelectedTopicId  = "";
let qSelectedQuizId   = "";

// Category builder state (only Lesson -> Topic)
let cLessonId = "";
let cTopicId = "";

// Category builder test panel state
let cSelectedQuizId = "";

/* ---------- Auth helpers ---------- */
const isAdmin = () => currentUser && currentUser.email === ADMIN_EMAIL;

/* ---------- Helpers ---------- */
function escapeHtml(str){
  return (str || "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function catPath(catId){
  const cat = categories.find(c=>c.id===catId);
  if(!cat) return "";
  const chain = [];
  let cur = cat;
  while(cur){
    chain.unshift(cur.name);
    cur = cur.parentId ? categories.find(c=>c.id===cur.parentId) : null;
    if (cur && chain.length > 30) break;
  }
  return chain.join(" / ");
}

function safeFileName(name){
  return (name || "image.png").replace(/[^\w.\-]+/g, "_");
}

function makeUUID(){
  if (crypto?.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now();
}

/* ---------- Category tree helpers ---------- */
function getCategoryDescendants(rootId){
  const out = [];
  const stack = [rootId];
  while(stack.length){
    const id = stack.pop();
    out.push(id);
    const kids = categories.filter(c=>c.parentId===id).map(c=>c.id);
    kids.forEach(k=>stack.push(k));
  }
  return out;
}
function getRootCategories(){
  return categories.filter(c=>!c.parentId);
}
function getDirectChildren(parentId){
  return categories.filter(c=>c.parentId===parentId);
}

/* ---------- Auth ---------- */
on("loginBtn", "click", async ()=>{
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
});

on("logoutBtn", "click", async ()=>{
  await signOut(auth);
});

onAuthStateChanged(auth, async (user)=>{
  currentUser = user;

  if(!user){
    if ($("userInfo")) $("userInfo").textContent = "Giriş yapılmadı.";
    if ($("loginBtn")) $("loginBtn").disabled = false;
    if ($("logoutBtn")) $("logoutBtn").disabled = true;
    setEnabled(false);
    clearUI();
    return;
  }

  if ($("userInfo")) {
    $("userInfo").textContent =
      `Giriş: ${user.displayName || ""} (${user.email}) ${isAdmin() ? "✅ Admin" : "👀 Öğrenci"}`;
  }
  if ($("loginBtn")) $("loginBtn").disabled = true;
  if ($("logoutBtn")) $("logoutBtn").disabled = false;

  setEnabled(true);
  await refreshAll();
});

function setEnabled(signedIn){
  const adminEnabled = signedIn && isAdmin();

  if ($("addLesson")) $("addLesson").disabled = !adminEnabled;
  if ($("addTopic")) $("addTopic").disabled = !adminEnabled;
  if ($("deleteSelectedCategory")) $("deleteSelectedCategory").disabled = !adminEnabled;

  if ($("addTestHere")) $("addTestHere").disabled = !adminEnabled;
  if ($("deleteSelectedTestHere")) $("deleteSelectedTestHere").disabled = !adminEnabled;

  if ($("addQuestion")) $("addQuestion").disabled = !adminEnabled;
  if ($("deleteSelectedQuiz")) $("deleteSelectedQuiz").disabled = !adminEnabled;

  if ($("startSolve")) $("startSolve").disabled = !signedIn || !selectedQuizId;
}

function clearUI(){
  if ($("questionList")) $("questionList").innerHTML = "";
  if ($("solveArea")) $("solveArea").innerHTML = "";

  ["lessonList","topicList","testList","qLessonList","qTopicList","qTestList","cLessonList","cTopicList","cTestList"]
    .forEach(id => { const el=$(id); if(el) el.innerHTML=""; });

  if ($("scoreInfo")) $("scoreInfo").textContent = "Skor: 0 / 0";
  if ($("progressInfo")) $("progressInfo").textContent = "İlerleme: -";

  pendingImage = { imageUrl: "", storagePath: "" };
  if ($("uploadStatus")) $("uploadStatus").textContent = "";
  if ($("pasteBox")) $("pasteBox").textContent = "Buraya tıkla ve Ctrl+V yap. (Ekran görüntüsü / kopyalanmış resim)";
  if ($("pastePreview")) { $("pastePreview").style.display="none"; $("pastePreview").src=""; }

  selectedLessonId=""; selectedTopicId=""; selectedQuizId="";
  qSelectedLessonId=""; qSelectedTopicId=""; qSelectedQuizId="";
  cLessonId=""; cTopicId=""; cSelectedQuizId="";
}

/* ---------- Firestore Read ---------- */
async function refreshAll(){
  categories = [];
  const catSnap = await getDocs(collection(db, "categories"));
  catSnap.forEach(d=>{
    const x = d.data();
    categories.push({ id:d.id, name:x.name, parentId:x.parentId || null });
  });

  quizzes = [];
  const quizSnap = await getDocs(collection(db, "quizzes"));
  quizSnap.forEach(d=>{
    const x = d.data();
    quizzes.push({ id:d.id, title:x.title, categoryId:x.categoryId });
  });

  questions = [];
  const qSnap = await getDocs(collection(db, "questions"));
  qSnap.forEach(d=>{
    const x = d.data();
    questions.push({
      id:d.id,
      quizId:x.quizId,
      correct:x.correct,
      imageUrl:x.imageUrl,
      explain:x.explain || "",
      storagePath:x.storagePath || ""
    });
  });

  renderAll();
}

/* ---------- UI Render ---------- */
function renderAll(){
  // question summary list
  if ($("questionList")) {
    if(questions.length===0){
      $("questionList").innerHTML = `<p class="muted">Henüz soru yok.</p>`;
    } else {
      const byQuiz = {};
      questions.forEach(qq => byQuiz[qq.quizId]=(byQuiz[qq.quizId]||0)+1);
      $("questionList").innerHTML = Object.entries(byQuiz).map(([quizId,count])=>{
        const q = quizzes.find(x=>x.id===quizId);
        const label = q ? `${catPath(q.categoryId)} / ${q.title}` : quizId;
        return `<span class="pill">${escapeHtml(label)}: ${count} soru</span>`;
      }).join("");
    }
  }

  renderSolvePicker();
  renderQuestionPicker();
  renderCategoryBuilder();
}

/* ---------- Ctrl+V: Paste & Upload Immediately ---------- */
const pasteBox = $("pasteBox");
const pastePreview = $("pastePreview");
const uploadStatus = $("uploadStatus");

if (pasteBox && pastePreview && uploadStatus) {
  pasteBox.addEventListener("click", () => pasteBox.focus());

  document.addEventListener("paste", async (e) => {
    const questionsPanel = document.getElementById("questions");
    const isQuestionsOpen = questionsPanel && questionsPanel.style.display !== "none";
    if (!isQuestionsOpen) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    let imgItem = null;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) { imgItem = it; break; }
    }
    if (!imgItem) return;

    const blob = imgItem.getAsFile();
    if (!blob) return;

    try {
      uploadStatus.textContent = "📤 Yükleniyor...";
      pasteBox.textContent = "📤 Yükleniyor...";

      const ext = (blob.type && blob.type.includes("jpeg")) ? "jpg" : "png";
      const id = makeUUID();
      const file = new File([blob], `pasted_${Date.now()}.${ext}`, { type: blob.type || "image/png" });

      const storagePath = `questions/${id}_${safeFileName(file.name)}`;
      const fileRef = ref(storage, storagePath);

      await uploadBytes(fileRef, file);
      const imageUrl = await getDownloadURL(fileRef);

      pendingImage = { imageUrl, storagePath };

      pastePreview.src = imageUrl;
      pastePreview.style.display = "block";

      uploadStatus.textContent = "✅ Yüklendi. Şimdi doğru şıkkı seçip 'Soruyu Kaydet' de.";
      pasteBox.textContent = "✅ Yüklendi. Tekrar Ctrl+V yaparsan yeni görsel yüklenir.";
    } catch (err) {
      console.error("PASTE UPLOAD ERROR:", err);
      pendingImage = { imageUrl: "", storagePath: "" };
      uploadStatus.textContent = `❌ Upload hatası: ${err?.code || ""} ${err?.message || err}`;
      pasteBox.textContent = "❌ Hata oldu. Tekrar Ctrl+V deneyebilirsin.";
      alert(`Upload hatası:\n${err?.code || ""}\n${err?.message || err}`);
    }
  });
}

/* ---------- Admin: Save Question (uses qSelectedQuizId + pendingImage) ---------- */
on("addQuestion","click", async ()=>{
  try {
    if(!isAdmin()) return alert("Sadece admin ekleyebilir.");

    const quizId = qSelectedQuizId;
    if(!quizId) return alert("Önce test seç (Ders → Konu → Test).");

    const correctInput = document.querySelector('input[name="correct"]:checked');
    if(!correctInput) return alert("Doğru şıkkı seç (A–E).");
    const correct = correctInput.value;

    const explain = $("explain")?.value.trim() || "";

    if(!pendingImage.imageUrl || !pendingImage.storagePath) {
      return alert("Önce Ctrl+V ile görsel yapıştırıp yüklemelisin.");
    }

    await addDoc(collection(db, "questions"), {
      quizId,
      correct,
      explain,
      imageUrl: pendingImage.imageUrl,
      storagePath: pendingImage.storagePath,
      createdAt: Date.now()
    });

    if ($("explain")) $("explain").value = "";
    document.querySelectorAll('input[name="correct"]').forEach(r=>r.checked=false);

    pendingImage = { imageUrl: "", storagePath: "" };
    if ($("uploadStatus")) $("uploadStatus").textContent = "";
    if ($("pasteBox")) $("pasteBox").textContent = "Buraya tıkla ve Ctrl+V yap. (Ekran görüntüsü / kopyalanmış resim)";
    if ($("pastePreview")) { $("pastePreview").style.display="none"; $("pastePreview").src=""; }

    await refreshAll();
    alert("Soru eklendi ✅");
  } catch (err) {
    console.error(err);
    alert(`${err?.code || ""}\n${err?.message || err}`);
  }
});

/* ---------- Admin: Delete selected quiz from Question tab ---------- */
on("deleteSelectedQuiz","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin silebilir.");

  const quizId = qSelectedQuizId;
  if(!quizId) return alert("Önce test seç (Ders → Konu → Test).");

  await deleteQuizCascade(quizId);
  await refreshAll();
});

/* ---------- Delete quiz cascade helper ---------- */
async function deleteQuizCascade(quizId){
  const qz = quizzes.find(x=>x.id===quizId);
  const label = qz ? `${catPath(qz.categoryId)} / ${qz.title}` : quizId;

  if(!confirm(`Bu testi ve içindeki tüm soruları silmek istiyor musun?\n\n${label}`)) return;

  const qQuery = query(collection(db, "questions"), where("quizId", "==", quizId));
  const qSnap = await getDocs(qQuery);

  for(const d of qSnap.docs){
    const x = d.data();
    if(x.storagePath){
      try { await deleteObject(ref(storage, x.storagePath)); } catch(_) {}
    }
    await deleteDoc(doc(db, "questions", d.id));
  }

  await deleteDoc(doc(db, "quizzes", quizId));
}

/* =========================================================
   SOLVE PICKER
   ========================================================= */
function renderSolvePicker(){
  const lessonList = $("lessonList");
  const topicList = $("topicList");
  const testList = $("testList");
  if(!lessonList || !topicList || !testList) return;

  const lessonQ = ($("lessonSearch")?.value || "").trim().toLowerCase();
  const topicQ  = ($("topicSearch")?.value || "").trim().toLowerCase();
  const testQ   = ($("testSearch")?.value || "").trim().toLowerCase();

  let lessons = getRootCategories();
  if(lessonQ) lessons = lessons.filter(c => catPath(c.id).toLowerCase().includes(lessonQ));

  if(!selectedLessonId && lessons.length) selectedLessonId = lessons[0].id;
  if(selectedLessonId && !lessons.find(x=>x.id===selectedLessonId)) {
    selectedLessonId = lessons.length ? lessons[0].id : "";
    selectedTopicId = "";
    selectedQuizId = "";
  }

  lessonList.innerHTML = lessons.length
    ? lessons.map(c=>`
      <div class="pickItem ${c.id===selectedLessonId?"active":""}" data-lesson="${c.id}">
        ${escapeHtml(c.name)}
      </div>
    `).join("")
    : `<div class="muted tiny">Ders bulunamadı.</div>`;

  lessonList.querySelectorAll("[data-lesson]").forEach(el=>{
    el.onclick = ()=>{
      selectedLessonId = el.dataset.lesson;
      selectedTopicId = "";
      selectedQuizId = "";
      renderSolvePicker();
    };
  });

  let topics = selectedLessonId ? getDirectChildren(selectedLessonId) : [];
  if(topicQ) topics = topics.filter(c => catPath(c.id).toLowerCase().includes(topicQ));

  if(!selectedTopicId && topics.length) selectedTopicId = topics[0].id;
  if(selectedTopicId && !topics.find(x=>x.id===selectedTopicId)) {
    selectedTopicId = topics.length ? topics[0].id : "";
    selectedQuizId = "";
  }

  topicList.innerHTML = topics.length
    ? topics.map(c=>`
      <div class="pickItem ${c.id===selectedTopicId?"active":""}" data-topic="${c.id}">
        ${escapeHtml(c.name)}
        <div class="muted tiny">${escapeHtml(catPath(c.id))}</div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu derste konu yok.</div>`;

  topicList.querySelectorAll("[data-topic]").forEach(el=>{
    el.onclick = ()=>{
      selectedTopicId = el.dataset.topic;
      selectedQuizId = "";
      renderSolvePicker();
    };
  });

  let visibleQuizzes = selectedTopicId
    ? quizzes.filter(q => q.categoryId === selectedTopicId)
    : [];

  if(testQ){
    visibleQuizzes = visibleQuizzes.filter(q=>{
      const p = `${q.title}`.toLowerCase();
      return p.includes(testQ);
    });
  }

  if(!selectedQuizId && visibleQuizzes.length) selectedQuizId = visibleQuizzes[0].id;
  if(selectedQuizId && !visibleQuizzes.find(x=>x.id===selectedQuizId)){
    selectedQuizId = visibleQuizzes.length ? visibleQuizzes[0].id : "";
  }

  testList.innerHTML = visibleQuizzes.length
    ? visibleQuizzes.map(q=>`
      <div class="testCard">
        <div class="testCardTitle">${escapeHtml(q.title)}</div>
        <div class="testCardPath">${escapeHtml(catPath(q.categoryId))}</div>
        <div class="testCardActions">
          <button class="secondary" type="button" data-start-quiz="${q.id}">Başlat</button>
        </div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu konu için test bulunamadı.</div>`;

  testList.querySelectorAll("[data-start-quiz]").forEach(btn=>{
    btn.onclick = ()=>{
      selectedQuizId = btn.dataset.startQuiz;
      startSolveByQuizId(selectedQuizId);
    };
  });

  if ($("startSolve")) $("startSolve").disabled = !currentUser || !selectedQuizId;
}

["lessonSearch","topicSearch","testSearch"].forEach(id=>{
  on(id,"input", ()=> renderSolvePicker());
});

/* =========================================================
   QUESTION PICKER (topic -> quizzes direct)
   ========================================================= */
function renderQuestionPicker(){
  const lessonList = $("qLessonList");
  const topicList  = $("qTopicList");
  const testList   = $("qTestList");
  const info       = $("qSelectedInfo");
  if(!lessonList || !topicList || !testList || !info) return;

  const lessonQ = ($("qLessonSearch")?.value || "").trim().toLowerCase();
  const topicQ  = ($("qTopicSearch")?.value || "").trim().toLowerCase();
  const testQ   = ($("qTestSearch")?.value || "").trim().toLowerCase();

  let lessons = getRootCategories();
  if(lessonQ) lessons = lessons.filter(c => catPath(c.id).toLowerCase().includes(lessonQ));

  if(!qSelectedLessonId && lessons.length) qSelectedLessonId = lessons[0].id;
  if(qSelectedLessonId && !lessons.find(x=>x.id===qSelectedLessonId)){
    qSelectedLessonId = lessons.length ? lessons[0].id : "";
    qSelectedTopicId = "";
    qSelectedQuizId = "";
  }

  lessonList.innerHTML = lessons.length
    ? lessons.map(c=>`
      <div class="pickItem ${c.id===qSelectedLessonId?"active":""}" data-q-lesson="${c.id}">
        ${escapeHtml(c.name)}
      </div>
    `).join("")
    : `<div class="muted tiny">Ders bulunamadı.</div>`;

  lessonList.querySelectorAll("[data-q-lesson]").forEach(el=>{
    el.onclick = ()=>{
      qSelectedLessonId = el.dataset.qLesson;
      qSelectedTopicId = "";
      qSelectedQuizId = "";
      renderQuestionPicker();
    };
  });

  let topics = qSelectedLessonId ? getDirectChildren(qSelectedLessonId) : [];
  if(topicQ) topics = topics.filter(c => catPath(c.id).toLowerCase().includes(topicQ));

  if(!qSelectedTopicId && topics.length) qSelectedTopicId = topics[0].id;
  if(qSelectedTopicId && !topics.find(x=>x.id===qSelectedTopicId)){
    qSelectedTopicId = topics.length ? topics[0].id : "";
    qSelectedQuizId = "";
  }

  topicList.innerHTML = topics.length
    ? topics.map(c=>`
      <div class="pickItem ${c.id===qSelectedTopicId?"active":""}" data-q-topic="${c.id}">
        ${escapeHtml(c.name)}
        <div class="muted tiny">${escapeHtml(catPath(c.id))}</div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu derste konu yok.</div>`;

  topicList.querySelectorAll("[data-q-topic]").forEach(el=>{
    el.onclick = ()=>{
      qSelectedTopicId = el.dataset.qTopic;
      qSelectedQuizId = "";
      renderQuestionPicker();
    };
  });

  let visibleQuizzes = qSelectedTopicId
    ? quizzes.filter(q => q.categoryId === qSelectedTopicId)
    : [];

  if(testQ){
    visibleQuizzes = visibleQuizzes.filter(q => q.title.toLowerCase().includes(testQ));
  }

  if(!qSelectedQuizId && visibleQuizzes.length) qSelectedQuizId = visibleQuizzes[0].id;
  if(qSelectedQuizId && !visibleQuizzes.find(x=>x.id===qSelectedQuizId)){
    qSelectedQuizId = visibleQuizzes.length ? visibleQuizzes[0].id : "";
  }

  testList.innerHTML = visibleQuizzes.length
    ? visibleQuizzes.map(q=>`
      <div class="testCard">
        <div class="testCardTitle">${escapeHtml(q.title)}</div>
        <div class="testCardPath">${escapeHtml(catPath(q.categoryId))}</div>
        <div class="testCardActions">
          <button class="secondary" type="button" data-q-select-quiz="${q.id}">Seç</button>
        </div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu konu için test bulunamadı.</div>`;

  testList.querySelectorAll("[data-q-select-quiz]").forEach(btn=>{
    btn.onclick = ()=>{
      qSelectedQuizId = btn.dataset.qSelectQuiz;
      renderQuestionPicker();
    };
  });

  if(qSelectedQuizId){
    const qz = quizzes.find(x=>x.id===qSelectedQuizId);
    info.textContent = qz ? `${catPath(qz.categoryId)} / ${qz.title}` : "Seçili test bulunamadı";
  } else {
    info.textContent = "Henüz test seçilmedi";
  }
}

["qLessonSearch","qTopicSearch","qTestSearch"].forEach(id=>{
  on(id,"input", ()=> renderQuestionPicker());
});

/* =========================================================
   CATEGORY BUILDER + TESTS (Lesson -> Topic, then quizzes list)
   ========================================================= */
function renderCategoryBuilder(){
  const lessonList = $("cLessonList");
  const topicList = $("cTopicList");
  const pathPill = $("cSelectedPath");
  const testList = $("cTestList");
  const testInfo = $("cSelectedTestInfo");

  if(!lessonList || !topicList || !pathPill || !testList || !testInfo) return;

  const lessonQ = ($("cLessonSearch")?.value || "").trim().toLowerCase();
  const topicQ = ($("cTopicSearch")?.value || "").trim().toLowerCase();
  const testQ = ($("cTestSearch")?.value || "").trim().toLowerCase();

  // lessons root
  let lessons = getRootCategories();
  if(lessonQ) lessons = lessons.filter(c => c.name.toLowerCase().includes(lessonQ));

  if(!cLessonId && lessons.length) cLessonId = lessons[0].id;
  if(cLessonId && !lessons.find(x=>x.id===cLessonId)){
    cLessonId = lessons.length ? lessons[0].id : "";
    cTopicId = "";
    cSelectedQuizId = "";
  }

  lessonList.innerHTML = lessons.length
    ? lessons.map(c=>`
      <div class="pickItem ${c.id===cLessonId?"active":""}" data-c-lesson="${c.id}">
        ${escapeHtml(c.name)}
      </div>
    `).join("")
    : `<div class="muted tiny">Ders yok.</div>`;

  lessonList.querySelectorAll("[data-c-lesson]").forEach(el=>{
    el.onclick = ()=>{
      cLessonId = el.dataset.cLesson;
      cTopicId = "";
      cSelectedQuizId = "";
      renderCategoryBuilder();
    };
  });

  // topics
  let topics = cLessonId ? getDirectChildren(cLessonId) : [];
  if(topicQ) topics = topics.filter(c => catPath(c.id).toLowerCase().includes(topicQ));

  if(!cTopicId && topics.length) cTopicId = topics[0].id;
  if(cTopicId && !topics.find(x=>x.id===cTopicId)){
    cTopicId = topics.length ? topics[0].id : "";
    cSelectedQuizId = "";
  }

  topicList.innerHTML = topics.length
    ? topics.map(c=>`
      <div class="pickItem ${c.id===cTopicId?"active":""}" data-c-topic="${c.id}">
        ${escapeHtml(c.name)}
        <div class="muted tiny">${escapeHtml(catPath(c.id))}</div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu derste konu yok.</div>`;

  topicList.querySelectorAll("[data-c-topic]").forEach(el=>{
    el.onclick = ()=>{
      cTopicId = el.dataset.cTopic;
      cSelectedQuizId = "";
      renderCategoryBuilder();
    };
  });

  // selected path
  pathPill.textContent = cTopicId ? `Seçili: ${catPath(cTopicId)}` : "Seçili: -";

  // tests of this topic only (direct)
  let t = cTopicId ? quizzes.filter(q => q.categoryId === cTopicId) : [];
  if(testQ) t = t.filter(q => q.title.toLowerCase().includes(testQ));

  if(!cSelectedQuizId && t.length) cSelectedQuizId = t[0].id;
  if(cSelectedQuizId && !t.find(x=>x.id===cSelectedQuizId)){
    cSelectedQuizId = t.length ? t[0].id : "";
  }

  testList.innerHTML = t.length
    ? t.map(q=>`
      <div class="testCard">
        <div class="testCardTitle">${escapeHtml(q.title)}</div>
        <div class="testCardPath">${escapeHtml(catPath(q.categoryId))}</div>
        <div class="testCardActions">
          <button class="secondary" type="button" data-c-select-quiz="${q.id}">Seç</button>
        </div>
      </div>
    `).join("")
    : `<div class="muted tiny">Bu konu için test yok.</div>`;

  testList.querySelectorAll("[data-c-select-quiz]").forEach(btn=>{
    btn.onclick = ()=>{
      cSelectedQuizId = btn.dataset.cSelectQuiz;
      renderCategoryBuilder();
    };
  });

  if(cSelectedQuizId){
    const qz = quizzes.find(x=>x.id===cSelectedQuizId);
    testInfo.textContent = qz ? `Seçili test: ${qz.title}` : "Seçili test: -";
  } else {
    testInfo.textContent = "Seçili test: -";
  }

  const admin = isAdmin();
  if ($("addLesson")) $("addLesson").disabled = !admin;
  if ($("addTopic")) $("addTopic").disabled = !admin || !cLessonId;
  if ($("deleteSelectedCategory")) $("deleteSelectedCategory").disabled = !admin || !cTopicId;

  if ($("addTestHere")) $("addTestHere").disabled = !admin || !cTopicId;
  if ($("deleteSelectedTestHere")) $("deleteSelectedTestHere").disabled = !admin || !cSelectedQuizId;
}

["cLessonSearch","cTopicSearch","cTestSearch"].forEach(id=>{
  on(id,"input", ()=> renderCategoryBuilder());
});

on("addLesson","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin.");
  const name = $("newLessonName")?.value.trim();
  if(!name) return alert("Ders adı boş olamaz.");
  await addDoc(collection(db, "categories"), { name, parentId: null });
  if ($("newLessonName")) $("newLessonName").value = "";
  await refreshAll();
});

on("addTopic","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin.");
  const name = $("newTopicName")?.value.trim();
  if(!name) return alert("Konu adı boş olamaz.");
  if(!cLessonId) return alert("Önce ders seç.");
  await addDoc(collection(db, "categories"), { name, parentId: cLessonId });
  if ($("newTopicName")) $("newTopicName").value = "";
  await refreshAll();
});

// Add test in right panel
on("addTestHere","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin.");
  if(!cTopicId) return alert("Önce konu seç.");
  const title = $("newTestName")?.value.trim();
  if(!title) return alert("Test adı boş olamaz.");

  await addDoc(collection(db, "quizzes"), { title, categoryId: cTopicId });
  if ($("newTestName")) $("newTestName").value = "";
  await refreshAll();
});

// Delete selected test in right panel
on("deleteSelectedTestHere","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin.");
  if(!cSelectedQuizId) return alert("Seçili test yok.");
  await deleteQuizCascade(cSelectedQuizId);
  cSelectedQuizId = "";
  await refreshAll();
});

// Delete selected topic cascade (topic + its tests + questions + images) BUT keep the lesson
on("deleteSelectedCategory","click", async ()=>{
  if(!isAdmin()) return alert("Sadece admin.");
  if(!cTopicId) return alert("Seçili konu yok.");

  const label = catPath(cTopicId);
  const catIds = getCategoryDescendants(cTopicId); // includes topic and any children (if exist in db)
  const quizIds = quizzes.filter(q => catIds.includes(q.categoryId)).map(q=>q.id);
  const qCount = questions.filter(q => quizIds.includes(q.quizId)).length;

  const ok = confirm(
    `Silmek istiyor musun?\n\n${label}\n\n` +
    `Test: ${quizIds.length}\nSoru: ${qCount}\n\n` +
    `Soruların resimleri de silinir.`
  );
  if(!ok) return;

  try {
    // quizzes + questions
    for(const quizId of quizIds){
      const qQuery = query(collection(db, "questions"), where("quizId", "==", quizId));
      const qSnap = await getDocs(qQuery);
      for(const d of qSnap.docs){
        const x = d.data();
        if(x.storagePath){
          try { await deleteObject(ref(storage, x.storagePath)); } catch(_) {}
        }
        await deleteDoc(doc(db, "questions", d.id));
      }
      await deleteDoc(doc(db, "quizzes", quizId));
    }

    // categories (topic and any children)
    for(const cid of [...catIds].reverse()){
      await deleteDoc(doc(db, "categories", cid));
    }

    cTopicId = "";
    cSelectedQuizId = "";
    await refreshAll();
    alert("Konu silindi ✅");
  } catch (err) {
    console.error(err);
    alert(`Silme hatası:\n${err?.code || ""}\n${err?.message || err}`);
  }
});

/* =========================================================
   SOLVE RENDER
   ========================================================= */
let solveState = { total:0, answered:0, correct:0 };

function updateScoreUI(){
  if ($("scoreInfo")) $("scoreInfo").textContent = `Skor: ${solveState.correct} / ${solveState.total}`;
  if ($("progressInfo")) {
    $("progressInfo").textContent = solveState.total
      ? `İlerleme: ${solveState.answered} / ${solveState.total}`
      : `İlerleme: -`;
  }
}

function startSolveByQuizId(quizId){
  const qs = questions.filter(q=>q.quizId===quizId);
  const area = $("solveArea");
  if (!area) return;
  area.innerHTML = "";

  solveState = { total: qs.length, answered: 0, correct: 0 };
  updateScoreUI();

  if(qs.length===0){
    area.innerHTML = `<div class="card"><p class="muted">Bu testte soru yok.</p></div>`;
    return;
  }

  const qz = quizzes.find(q=>q.id===quizId);
  const header = document.createElement("div");
  header.className = "card";
  header.innerHTML = `<h2>${escapeHtml(catPath(qz.categoryId))} / ${escapeHtml(qz.title)}</h2>
                      <p class="muted">${qs.length} soru. Görselde şıklar var, aşağıdan A–E seç.</p>`;
  area.appendChild(header);

  const lockAfter = $("lockAfterAnswer")?.checked ?? true;
  const showCorrectOnWrong = $("showCorrectOnWrong")?.checked ?? true;

  qs.forEach((q, idx)=>{
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.correct = q.correct;
    card.dataset.answered = "0";

    card.innerHTML = `
      <h3>Soru ${idx+1}</h3>
      <img class="qimg" src="${q.imageUrl}" alt="soru görseli"/>
      <div class="choices">
        ${["A","B","C","D","E"].map(ch=>`<button type="button" data-choice="${ch}">${ch}</button>`).join("")}
      </div>
      <p class="result"></p>
      ${q.explain ? `<p class="muted"><b>Açıklama:</b> ${escapeHtml(q.explain)}</p>` : ``}
    `;

    const result = card.querySelector(".result");

    card.querySelectorAll("button").forEach(btn=>{
      btn.onclick = ()=>{
        if(card.dataset.answered === "1" && lockAfter) return;

        const chosen = btn.dataset.choice;
        const correct = card.dataset.correct;

        card.querySelectorAll("button").forEach(b=>b.classList.remove("correct","wrong"));

        const ok = chosen === correct;

        if(ok){
          btn.classList.add("correct");
          result.textContent = "✅ Doğru";
        } else {
          btn.classList.add("wrong");
          result.textContent = `❌ Yanlış${showCorrectOnWrong ? `. Doğru: ${correct}` : ""}`;
          if(showCorrectOnWrong){
            const cbtn = card.querySelector(`button[data-choice="${correct}"]`);
            if(cbtn) cbtn.classList.add("correct");
          }
        }

        if(card.dataset.answered === "0"){
          card.dataset.answered = "1";
          solveState.answered += 1;
          if(ok) solveState.correct += 1;
          updateScoreUI();
        }

        if(lockAfter){
          card.querySelectorAll("button").forEach(b=>b.disabled = true);
        }
      };
    });

    area.appendChild(card);
  });
}
