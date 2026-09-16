require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'quiz-platform.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, icon TEXT DEFAULT '📚', image_url TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quizzes (id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, duration_minutes INTEGER DEFAULT 15, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, quiz_id INTEGER NOT NULL, text TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('multiple_choice','true_false')), image_url TEXT, points REAL DEFAULT 1, position INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS choices (id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL, text TEXT NOT NULL, is_correct INTEGER DEFAULT 0, position INTEGER DEFAULT 0, FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, quiz_id INTEGER NOT NULL, student_name TEXT, score REAL NOT NULL, total_points REAL NOT NULL, percentage REAL NOT NULL, answers_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE);
`);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'development-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 8 } }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
const requireAdmin = (req, res, next) => req.session.isAdmin ? next() : res.status(401).json({ error: 'يجب تسجيل الدخول إلى لوحة التحكم.' });
const body = v => String(v || '').trim();

app.get('/api/subjects', (req, res) => res.json(db.prepare(`SELECT s.*, COUNT(DISTINCT q.id) quiz_count FROM subjects s LEFT JOIN quizzes q ON q.subject_id=s.id AND q.active=1 WHERE s.active=1 GROUP BY s.id ORDER BY s.id DESC`).all()));
app.get('/api/subjects/:id/quizzes', (req, res) => res.json(db.prepare(`SELECT q.*, COUNT(questions.id) question_count FROM quizzes q LEFT JOIN questions ON questions.quiz_id=q.id WHERE q.subject_id=? AND q.active=1 GROUP BY q.id ORDER BY q.id DESC`).all(req.params.id)));
app.get('/api/quizzes/:id', (req, res) => {
  const quiz = db.prepare('SELECT q.*, s.name subject_name FROM quizzes q JOIN subjects s ON s.id=q.subject_id WHERE q.id=? AND q.active=1').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'الاختبار غير موجود.' });
  const questions = db.prepare('SELECT id,text,type,image_url,points,position FROM questions WHERE quiz_id=? ORDER BY position,id').all(quiz.id);
  const choices = db.prepare('SELECT id,question_id,text,position FROM choices WHERE question_id IN (SELECT id FROM questions WHERE quiz_id=?) ORDER BY position,id').all(quiz.id);
  res.json({ ...quiz, questions: questions.map(q => ({ ...q, choices: choices.filter(c => c.question_id === q.id) })) });
});
app.post('/api/quizzes/:id/submit', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=? AND active=1').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'الاختبار غير موجود.' });
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position,id').all(quiz.id);
  const answerMap = req.body.answers || {}; let score = 0; const results = [];
  for (const q of questions) {
    const choices = db.prepare('SELECT id,text,is_correct FROM choices WHERE question_id=? ORDER BY position,id').all(q.id);
    const selected = Number(answerMap[q.id]) || null;
    const correct = choices.find(c => c.is_correct);
    const isCorrect = !!correct && selected === correct.id;
    if (isCorrect) score += q.points;
    results.push({ questionId: q.id, selectedChoiceId: selected, correctChoiceId: correct?.id || null, isCorrect, points: q.points });
  }
  const total = questions.reduce((n, q) => n + q.points, 0); const percentage = total ? Math.round((score / total) * 10000) / 100 : 0;
  db.prepare('INSERT INTO attempts (quiz_id,student_name,score,total_points,percentage,answers_json) VALUES (?,?,?,?,?,?)').run(quiz.id, body(req.body.studentName).slice(0, 100) || 'طالب', score, total, percentage, JSON.stringify(results));
  res.json({ score, total, percentage, results });
});

app.post('/api/admin/login', (req, res) => {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com'; const password = process.env.ADMIN_PASSWORD || 'change-me-now';
  if (body(req.body.email) !== email || String(req.body.password || '') !== password) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  req.session.isAdmin = true; res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!match) return res.status(400).json({ error: 'اختر صورة بصيغة PNG أو JPG أو WEBP أو GIF.' });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'حجم الصورة يجب ألا يتجاوز 3 ميجابايت.' });
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  fs.writeFileSync(path.join(__dirname, 'uploads', filename), bytes);
  res.json({ url: `/uploads/${filename}` });
});
app.get('/api/admin/dashboard', requireAdmin, (req, res) => res.json({ subjects: db.prepare('SELECT * FROM subjects ORDER BY id DESC').all(), quizzes: db.prepare('SELECT q.*,s.name subject_name,COUNT(questions.id) question_count FROM quizzes q JOIN subjects s ON s.id=q.subject_id LEFT JOIN questions ON questions.quiz_id=q.id GROUP BY q.id ORDER BY q.id DESC').all(), attempts: db.prepare('SELECT a.*,q.title quiz_title FROM attempts a JOIN quizzes q ON q.id=a.quiz_id ORDER BY a.id DESC LIMIT 30').all() }));
app.post('/api/admin/subjects', requireAdmin, (req,res) => { const x=req.body; if(!body(x.name)) return res.status(400).json({error:'اسم المادة مطلوب.'}); const r=db.prepare('INSERT INTO subjects(name,description,icon,image_url,active) VALUES (?,?,?,?,?)').run(body(x.name),body(x.description),body(x.icon)||'📚',body(x.image_url),x.active===false?0:1); res.json({id:r.lastInsertRowid}); });
app.put('/api/admin/subjects/:id', requireAdmin, (req,res) => { const x=req.body; db.prepare('UPDATE subjects SET name=?,description=?,icon=?,image_url=?,active=? WHERE id=?').run(body(x.name),body(x.description),body(x.icon)||'📚',body(x.image_url),x.active===false?0:1,req.params.id); res.json({ok:true}); });
app.delete('/api/admin/subjects/:id', requireAdmin, (req,res) => { db.prepare('DELETE FROM subjects WHERE id=?').run(req.params.id); res.json({ok:true}); });
app.post('/api/admin/quizzes', requireAdmin, (req,res) => { const x=req.body; if(!x.subject_id||!body(x.title)) return res.status(400).json({error:'المادة واسم الاختبار مطلوبان.'}); const r=db.prepare('INSERT INTO quizzes(subject_id,title,description,duration_minutes,active) VALUES (?,?,?,?,?)').run(x.subject_id,body(x.title),body(x.description),Number(x.duration_minutes)||15,x.active===false?0:1); res.json({id:r.lastInsertRowid}); });
app.put('/api/admin/quizzes/:id', requireAdmin, (req,res) => { const x=req.body; db.prepare('UPDATE quizzes SET subject_id=?,title=?,description=?,duration_minutes=?,active=? WHERE id=?').run(x.subject_id,body(x.title),body(x.description),Number(x.duration_minutes)||15,x.active===false?0:1,req.params.id); res.json({ok:true}); });
app.delete('/api/admin/quizzes/:id', requireAdmin, (req,res) => { db.prepare('DELETE FROM quizzes WHERE id=?').run(req.params.id); res.json({ok:true}); });
app.get('/api/admin/quizzes/:id/questions', requireAdmin, (req,res) => { const questions=db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position,id').all(req.params.id); const picks=db.prepare('SELECT * FROM choices WHERE question_id IN (SELECT id FROM questions WHERE quiz_id=?) ORDER BY position,id').all(req.params.id); res.json(questions.map(q=>({...q,choices:picks.filter(c=>c.question_id===q.id)}))); });
function saveQuestion(req,res,isUpdate) { const x=req.body; const choices=Array.isArray(x.choices)?x.choices:[]; if(!body(x.text)||!x.quiz_id||choices.length<2||!choices.some(c=>c.is_correct)) return res.status(400).json({error:'أدخل السؤال وخيارين على الأقل وحدد إجابة صحيحة.'}); const tx=db.transaction(()=>{ let id=req.params.id; if(isUpdate){db.prepare('UPDATE questions SET quiz_id=?,text=?,type=?,image_url=?,points=?,position=? WHERE id=?').run(x.quiz_id,body(x.text),x.type==='true_false'?'true_false':'multiple_choice',body(x.image_url),Number(x.points)||1,Number(x.position)||0,id);db.prepare('DELETE FROM choices WHERE question_id=?').run(id);}else{id=db.prepare('INSERT INTO questions(quiz_id,text,type,image_url,points,position) VALUES (?,?,?,?,?,?)').run(x.quiz_id,body(x.text),x.type==='true_false'?'true_false':'multiple_choice',body(x.image_url),Number(x.points)||1,Number(x.position)||0).lastInsertRowid;} const add=db.prepare('INSERT INTO choices(question_id,text,is_correct,position) VALUES (?,?,?,?)'); choices.filter(c=>body(c.text)).forEach((c,i)=>add.run(id,body(c.text),c.is_correct?1:0,i)); return id; }); res.json({id:tx()}); }
app.post('/api/admin/questions', requireAdmin, (req,res)=>saveQuestion(req,res,false));
app.put('/api/admin/questions/:id', requireAdmin, (req,res)=>saveQuestion(req,res,true));
app.delete('/api/admin/questions/:id', requireAdmin, (req,res)=>{db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);res.json({ok:true});});
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(process.env.PORT || 3000, () => console.log(`Quiz platform: http://localhost:${process.env.PORT || 3000}`));

