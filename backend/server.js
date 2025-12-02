\
/*
 Enhanced backend:
 - Excel error correction & sorting (register normalization)
 - Multi-day schedule support
 - Admin JWT auth scaffolding
 - Optimizer bridge to Python OR-Tools service (optional)
 - Blueprint detection stub (image -> rows/cols heuristic)
*/

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('child_process');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Simple admin user (for MVP). In production, use a proper DB.
const ADMIN = { username: process.env.ADMIN_USER || 'admin', passwordHash: process.env.ADMIN_PASS_HASH || bcrypt.hashSync('changeme', 8) };
const JWT_SECRET = process.env.JWT_SECRET || 'exam-secret';

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

// Utilities
function shuffleArray(arr) {
  for (let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const PAREN_REGEX = /^(.+?)\s*\(\s*([^)]+)\s*\)\s*$/;

function extractFromCombinedCell(cell){
  if (cell===undefined || cell===null) return null;
  const s = String(cell).trim();
  const m = s.match(PAREN_REGEX);
  if (m) return { left: m[1].trim(), right: m[2].trim() };
  const idx = s.lastIndexOf('(');
  if (idx !== -1 && s.endsWith(')')) return { left: s.slice(0, idx).trim(), right: s.slice(idx+1,-1).trim() };
  return { left: s, right: '' };
}

function normalizeRegister(reg){
  if (!reg) return '';
  return String(reg).trim().replace(/\s+/g,'').toUpperCase();
}

// parse student robustly and correct numbering scheme if present
function parseStudentRowRobust(row){
  const keys = Object.keys(row||{});
  let studentCol=null, nameCol=null, regCol=null, courseCol=null, subjCol=null;
  for (const k of keys){
    const kl = k.toLowerCase();
    if (!studentCol && (kl==='student' || kl.includes('student') || kl.includes('name('))) studentCol=k;
    if (!nameCol && (kl==='name' || kl.includes('student name'))) nameCol=k;
    if (!regCol && (kl.includes('reg') || kl.includes('register') || kl.includes('roll'))) regCol=k;
    if (!courseCol && (kl.includes('course') || kl.includes('course name') || kl.includes('programme'))) courseCol=k;
    if (!subjCol && (kl.includes('sub') || kl.includes('subject') || kl.includes('code'))) subjCol=k;
  }

  let student_name='', register_number='';
  if (studentCol && String(row[studentCol]||'').trim()!==''){
    const p = extractFromCombinedCell(row[studentCol]);
    if (p){ student_name=p.left; register_number=p.right; }
    else student_name=String(row[studentCol]).trim();
  } else {
    if (nameCol) student_name = String(row[nameCol]||'').trim();
    if (regCol) register_number = String(row[regCol]||'').trim();
  }

  let subject_code='', subject_name='';
  if (courseCol && String(row[courseCol]||'').trim()!==''){
    const p = extractFromCombinedCell(row[courseCol]);
    if (p){ subject_name=p.left; subject_code=p.right; }
    else subject_name=String(row[courseCol]).trim();
  } else if (subjCol && String(row[subjCol]||'').trim()!==''){
    const p=extractFromCombinedCell(row[subjCol]);
    if (p){ subject_name=p.left; subject_code=p.right; } else subject_code=String(row[subjCol]).trim();
  } else {
    for (const k of keys){
      const v = String(row[k]||'').trim();
      if (v && v.length<=8 && /[A-Za-z0-9]/.test(v) && !k.toLowerCase().includes('name')){ subject_code=v; break; }
    }
  }

  register_number = normalizeRegister(register_number);
  subject_code = (subject_code||'').toString().trim().toUpperCase();
  return { register_number, student_name, subject_code, subject_name };
}

function safeReadWorkbook(filepath){
  const wb = XLSX.readFile(filepath, {cellDates:true});
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, {defval:''});
}

function readStudentsFromFile(filepath){
  const raw = safeReadWorkbook(filepath);
  const parsed = raw.map(r => {
    if (r.student_name || r.register_number || r.subject_code) {
      return { register_number: normalizeRegister(r.register_number||''), student_name: (r.student_name||'').toString().trim(), subject_code: (r.subject_code||'').toString().toUpperCase() };
    }
    const p = parseStudentRowRobust(r);
    return { register_number: p.register_number||'', student_name: p.student_name||'', subject_code: p.subject_code||'' };
  });

  // Error correction: remove duplicates (by register), fix empty registers by synthetic ids, sort
  const seen = new Set();
  const unique = [];
  for (const s of parsed){
    if (s.register_number && seen.has(s.register_number)) continue;
    if (s.register_number) seen.add(s.register_number);
    unique.push(s);
  }
  let syntheticCounter = 1;
  for (const s of unique){
    if (!s.register_number || s.register_number==='') {
      s.register_number = `SYN${String(syntheticCounter).padStart(4,'0')}`;
      syntheticCounter++;
    }
  }
  unique.sort((a,b)=> (a.register_number < b.register_number ? -1 : 1));
  return unique;
}

function readHallListFromFile(filepath, defaultBenches=30){
  const raw = safeReadWorkbook(filepath);
  return raw.map((r,i)=>{
    const keys = Object.keys(r);
    let hallKey=null, benchesKey=null, rowsKey=null, colsKey=null;
    for (const k of keys){
      const kn = k.toLowerCase();
      if (!hallKey && (kn.includes('hall')||kn.includes('class')||kn.includes('room')||kn.includes('id'))) hallKey=k;
      if (!benchesKey && (kn.includes('bench')||kn.includes('seat')||kn.includes('capacity')||kn.includes('benches'))) benchesKey=k;
      if (!rowsKey && (kn==='rows' || kn.includes('row'))) rowsKey=k;
      if (!colsKey && (kn==='cols' || kn.includes('col') || kn.includes('column'))) colsKey=k;
    }
    const hall_id = hallKey ? String(r[hallKey]) : `Hall_${i+1}`;
    const benches = benchesKey && r[benchesKey] !== '' ? parseInt(r[benchesKey],10) || defaultBenches : defaultBenches;
    const rows = rowsKey && r[rowsKey] !== '' ? parseInt(r[rowsKey],10) || null : null;
    const cols = colsKey && r[colsKey] !== '' ? parseInt(r[colsKey],10) || null : null;
    return { hall_id, benches, rows, cols };
  }).sort((a,b)=> (a.hall_id < b.hall_id ? -1 : 1));
}

function benchToRowCol(benchNumber, rows, cols){
  if (!rows || !cols) return { row: null, col: null };
  const row = Math.ceil(benchNumber / cols);
  const col = ((benchNumber - 1) % cols) + 1;
  return { row, col };
}

// Balanced randomized distribution
function distributeBalanced(studentsArr, hallDefs){
  const bySub = new Map();
  for (const s of studentsArr){
    const key = (s.subject_code || '__NONE__').toString();
    if (!bySub.has(key)) bySub.set(key, []);
    bySub.get(key).push(s);
  }
  for (const [_, q] of bySub.entries()) shuffleArray(q);
  const subjects = Array.from(bySub.entries()).map(([k,v])=>({ subject:k, q:v.slice(), count:v.length }));
  subjects.sort((a,b)=>b.count - a.count);
  const assignments = [];
  for (const h of hallDefs){
    const capacity = h.benches;
    const hallSeats = new Array(capacity).fill(null);
    let idx = 0;
    while (idx < capacity){
      let placed = false;
      for (let i=0;i<subjects.length && idx<capacity;i++){
        const sub = subjects[i];
        if (sub.q.length === 0) continue;
        hallSeats[idx] = sub.q.shift();
        idx++;
        placed = true;
      }
      if (!placed) break;
    }
    for (let b=0;b<hallSeats.length;b++){
      if (hallSeats[b]) assignments.push({ hall_id: h.hall_id, bench_index_in_hall: b+1, student: hallSeats[b] });
    }
  }
  const remaining = [];
  for (const sub of subjects) while (sub.q.length) remaining.push(sub.q.shift());
  if (remaining.length > 0){
    const positions = [];
    for (const h of hallDefs) for (let b=1;b<=h.benches;b++) positions.push({ hall_id: h.hall_id, bench: b });
    const used = new Set(assignments.map(a=> `${a.hall_id}#${a.bench_index_in_hall}`));
    let i=0;
    for (const p of positions){
      if (i >= remaining.length) break;
      const key = `${p.hall_id}#${p.bench}`;
      if (!used.has(key)){
        assignments.push({ hall_id: p.hall_id, bench_index_in_hall: p.bench, student: remaining[i++] });
        used.add(key);
      }
    }
  }
  return assignments;
}

function buildOutputsFromAssignments(assignments, hallDefs){
  const out = [];
  const map = new Map();
  for (const a of assignments) map.set(`${a.hall_id}#${a.bench_index_in_hall}`, a.student);
  for (const h of hallDefs){
    for (let b=1;b<=h.benches;b++){
      const key = `${h.hall_id}#${b}`;
      const s = map.get(key);
      const rc = benchToRowCol(b, h.rows, h.cols);
      out.push({ hall_id: h.hall_id, bench_number: b, row: rc.row, col: rc.col, register_number: s ? s.register_number : '', student_name: s ? s.student_name : '', subject_code: s ? s.subject_code : '' });
    }
  }
  return out;
}

function buildVizAOA(rowsForHall, h){
  const R = h.rows, C = h.cols;
  const aoa = Array.from({length:R}, ()=>Array.from({length:C}, ()=>'Empty'));
  for (const r of rowsForHall){
    const rr = r.row ? r.row-1 : Math.floor((r.bench_number-1)/C);
    const cc = r.col ? r.col-1 : ((r.bench_number-1)%C);
    const txt = (r.student_name||'') + (r.register_number ? ` (${r.register_number})` : '') + (r.subject_code ? `\n${r.subject_code}` : '');
    aoa[rr][cc] = txt || 'Empty';
  }
  return aoa;
}

function saveJson(obj, prefix){
  const name = `${prefix}_${Date.now()}.json`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
  return name;
}

/* ---------------- API ---------------- */

// Admin login (simple)
app.post('/api/admin/login', (req,res)=>{
  try {
    const { username, password } = req.body;
    if (username !== ADMIN.username) return res.status(401).json({ ok:false, error:'invalid' });
    if (!bcrypt.compareSync(password, ADMIN.passwordHash)) return res.status(401).json({ ok:false, error:'invalid' });
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ ok:true, token });
  } catch (e){ return res.status(500).json({ ok:false, error: e.message }); }
});

// Upload students
app.post('/api/upload/students', upload.array('students'), (req,res)=>{
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok:false, error:'no files' });
    let students = [];
    for (const f of files) students = students.concat(readStudentsFromFile(f.path));
    const name = saveJson(students, 'students');
    return res.json({ ok:true, file: name, count: students.length });
  } catch (err) { console.error(err); return res.status(500).json({ ok:false, error: err.message }); }
});

// Upload halls
app.post('/api/upload/halls', upload.single('hallList'), (req,res)=>{
  try {
    const file = req.file;
    const defaultBenches = parseInt(req.body.defaultBenches || '30', 10) || 30;
    if (!file) return res.status(400).json({ ok:false, error:'no file' });
    const halls = readHallListFromFile(file.path, defaultBenches);
    const name = saveJson(halls, 'halls');
    return res.json({ ok:true, file: name, count: halls.length });
  } catch (err) { console.error(err); return res.status(500).json({ ok:false, error: err.message }); }
})

// Update students
app.post('/api/update-students', (req,res)=>{
  try {
    const students = req.body.students;
    if (!Array.isArray(students)) return res.status(400).json({ ok:false, error:'students must be array' });
    for (const s of students) s.register_number = normalizeRegister(s.register_number || s.register_number);
    students.sort((a,b)=> (a.register_number < b.register_number ? -1 : 1));
    const name = saveJson(students, 'students');
    return res.json({ ok:true, file: name, count: students.length });
  } catch (err) { console.error(err); return res.status(500).json({ ok:false, error: err.message }); }
});

// Allocation (multi-day support)
app.post('/api/allocate', (req,res)=>{
  try {
    const { studentsFile, hallsFile, numHalls, benchesPerHall, allocator, days } = req.body;
    if (!studentsFile) return res.status(400).json({ ok:false, error:'studentsFile required' });
    const studentsPath = path.join(UPLOAD_DIR, studentsFile);
    if (!fs.existsSync(studentsPath)) return res.status(400).json({ ok:false, error:'studentsFile not found' });
    let students = JSON.parse(fs.readFileSync(studentsPath,'utf8'));

    const hallDefs = [];
    if (hallsFile) {
      const hallsPath = path.join(UPLOAD_DIR, hallsFile);
      if (!fs.existsSync(hallsPath)) return res.status(400).json({ ok:false, error:'hallsFile not found' });
      const rawHalls = JSON.parse(fs.readFileSync(hallsPath,'utf8'));
      for (const h of rawHalls) {
        const benches = h.benches || 30;
        let rows = h.rows || null, cols = h.cols || null;
        if (!rows && !cols) { cols = 10; rows = Math.ceil(benches / cols); }
        else if (rows && !cols) cols = Math.ceil(benches / rows);
        else if (cols && !rows) rows = Math.ceil(benches / cols);
        if (rows * cols < benches) cols = Math.ceil(benches / rows);
        hallDefs.push({ hall_id: h.hall_id, benches, rows, cols });
      }
    } else {
      const n = parseInt(numHalls || 0, 10);
      const b = parseInt(benchesPerHall || 30, 10);
      for (let i=1;i<=n;i++){ const cols=10; const rows=Math.ceil(b/cols); hallDefs.push({ hall_id:`Hall_${i}`, benches: b, rows, cols }); }
    }

    const allocationsByDay = {};
    if (Array.isArray(days) && days.length>0){
      for (const d of days){
        let pool = students;
        if (Array.isArray(d.subjects) && d.subjects.length>0){
          const set = new Set(d.subjects.map(s=>s.toString().toUpperCase()));
          pool = students.filter(s => set.has((s.subject_code||'').toString().toUpperCase()));
        }
        shuffleArray(pool);
        let assignments = [];
        if (!allocator || allocator==='odd'){
          const oddDefs = hallDefs.map(h => ({ hall_id: h.hall_id, benches: Math.ceil(h.benches/2), rows: h.rows, cols: Math.ceil(h.cols/2) }));
          const a = distributeBalanced(pool, oddDefs);
          for (const x of a) assignments.push({ hall_id: x.hall_id, bench_number: (x.bench_index_in_hall-1)*2 + 1, student: x.student });
        } else {
          const a = distributeBalanced(pool, hallDefs);
          for (const x of a) assignments.push({ hall_id: x.hall_id, bench_number: x.bench_index_in_hall, student: x.student });
        }
        const finalRows = buildOutputsFromAssignments(assignments, hallDefs);
        allocationsByDay[d.day || `day_${Math.random().toString(36).slice(2,6)}`] = finalRows;
      }
    } else {
      shuffleArray(students);
      let assignments = [];
      if (!allocator || allocator==='odd'){
        const oddDefs = hallDefs.map(h => ({ hall_id: h.hall_id, benches: Math.ceil(h.benches/2), rows: h.rows, cols: Math.ceil(h.cols/2) }));
        const a = distributeBalanced(students, oddDefs);
        for (const x of a) assignments.push({ hall_id: x.hall_id, bench_number: (x.bench_index_in_hall-1)*2 + 1, student: x.student });
      } else {
        const a = distributeBalanced(students, hallDefs);
        for (const x of a) assignments.push({ hall_id: x.hall_id, bench_number: x.bench_index_in_hall, student: x.student });
      }
      const finalRows = buildOutputsFromAssignments(assignments, hallDefs);
      allocationsByDay['single'] = finalRows;
    }

    const manifest = {};
    for (const [k, rows] of Object.entries(allocationsByDay)){
      const fname = `allocation_${k}_${Date.now()}.json`;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), JSON.stringify(rows, null, 2), 'utf8');
      manifest[k] = fname;
      const wb = XLSX.utils.book_new();
      const wsAll = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, wsAll, 'bench_allocations');
      for (const h of hallDefs){
        const rowsForHall = rows.filter(r=>r.hall_id===h.hall_id).sort((a,b)=>a.bench_number - b.bench_number);
        const roster = XLSX.utils.json_to_sheet(rowsForHall.map(r=>({ bench_number: r.bench_number, row: r.row, col: r.col, register_number: r.register_number, student_name: r.student_name, subject_code: r.subject_code })));
        XLSX.utils.book_append_sheet(wb, roster, `${String(h.hall_id).substring(0,25)}_roster`.substring(0,31));
        const aoa = buildVizAOA(rowsForHall, h);
        const viz = XLSX.utils.aoa_to_sheet(aoa);
        XLSX.utils.book_append_sheet(wb, viz, `${String(h.hall_id).substring(0,25)}_viz`.substring(0,31));
      }
      const outFile = path.join(UPLOAD_DIR, `allocation_${k}_${Date.now()}.xlsx`);
      XLSX.writeFile(wb, outFile);
      manifest[`${k}_xlsx`] = path.basename(outFile);
    }

    const manifestName = `manifest_${Date.now()}.json`;
    fs.writeFileSync(path.join(UPLOAD_DIR, manifestName), JSON.stringify(manifest, null, 2), 'utf8');

    return res.json({ ok:true, manifestFile: manifestName, days: Object.keys(manifest).length/2 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// Blueprint detection stub
app.post('/api/blueprint/analyze', upload.single('blueprint'), (req,res)=>{
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'no file' });
    const stats = fs.statSync(req.file.path);
    const area = Math.max(1, stats.size % 1000);
    const rows = Math.max(3, Math.min(50, Math.round((area % 30) + 5)));
    const cols = Math.max(3, Math.min(20, Math.round((area % 10) + 5)));
    return res.json({ ok:true, rows, cols, note: 'Heuristic stub. Use OpenCV for production.' });
  } catch (err) { console.error(err); return res.status(500).json({ ok:false, error: err.message }); }
});

// Optimizer bridge
app.post('/api/optimize', (req,res)=>{
  try {
    const { studentsFile, hallsFile } = req.body;
    if (!studentsFile || !hallsFile) return res.status(400).json({ ok:false, error:'studentsFile and hallsFile required' });
    const py = path.join(__dirname, '..', 'optimizer', 'optimize.py');
    if (!fs.existsSync(py)) return res.status(400).json({ ok:false, error:'optimizer not installed. See README.' });
    const p = spawnSync('python3', [py, path.join(UPLOAD_DIR, studentsFile), path.join(UPLOAD_DIR, hallsFile)], { encoding:'utf8', maxBuffer: 10*1024*1024 });
    if (p.error) return res.status(500).json({ ok:false, error: p.error.message });
    if (p.status !== 0) return res.status(500).json({ ok:false, error: p.stderr || 'python error' });
    const out = p.stdout || '';
    return res.json({ ok:true, output: out });
  } catch (err) { console.error(err); return res.status(500).json({ ok:false, error: err.message }); }
});

app.use('/uploads', express.static(UPLOAD_DIR));
const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=> console.log('Backend listening on', PORT));
