import React, { useState } from 'react';
import axios from 'axios';
const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export default function App(){
  const [studentsFiles, setStudentsFiles] = useState([]), [hallFile,setHallFile]=useState(null);
  const [status,setStatus]=useState(''); const [allocation,setAllocation]=useState(null);
  async function uploadStudents(){ if(!studentsFiles.length) return alert('pick files'); const fd=new FormData(); studentsFiles.forEach(f=>fd.append('students',f)); setStatus('uploading'); const r=await axios.post(`${API}/api/upload/students`, fd); setStatus(r.data.ok? 'uploaded':'error'); }
  async function uploadHalls(){ if(!hallFile) return alert('pick hall file'); const fd=new FormData(); fd.append('hallList', hallFile); const r=await axios.post(`${API}/api/upload/halls`, fd); setStatus(r.data.ok? 'halls uploaded':'error'); }
  async function allocate(){ setStatus('allocating'); /* simplified: user should call allocate with studentsFile id returned previously */ alert('Use polished UI to allocate. This is a scaffold.'); }
  return (<div><h2>ExamSeater — Enhanced (Scaffold)</h2>
  <div><input type='file' multiple onChange={e=>setStudentsFiles(Array.from(e.target.files))} /> <button onClick={uploadStudents}>Upload Students</button></div>
  <div><input type='file' onChange={e=>setHallFile(e.target.files[0])} /> <button onClick={uploadHalls}>Upload Halls</button></div>
  <div>Status: {status}</div></div>); 
}
