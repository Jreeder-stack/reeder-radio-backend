import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getRadios,
  preRegisterRadio,
  assignRadioUnit,
  lockRadio,
  kioskUnlockRadio,
  kioskRelockRadio,
  getRadioUsers,
} from '../utils/radiosApi.js';
import { useTheme } from '../context/ThemeContext.jsx';

const DEFAULT_KIOSK_UNLOCK_MINUTES = 15;

function formatRemainingMinutes(expiresAt, nowMs) {
  if (!expiresAt) return null;
  const expiresMs = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  const remainingMin = Math.ceil((expiresMs - nowMs) / 60000);
  if (remainingMin < 60) return `${remainingMin}m`;
  const hrs = Math.floor(remainingMin / 60);
  const mins = remainingMin % 60;
  return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatLastSeen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function StatusBadge({ radio }) {
  const pending = !radio.last_seen;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 700,
      color: pending ? '#92400e' : '#166534',
      background: pending ? 'rgba(245,158,11,.15)' : 'rgba(34,197,94,.15)',
    }}>
      {pending ? 'Pending' : 'Registered'}
    </span>
  );
}

function Toast({ message, visible }) {
  if (!visible) return null;
  return <div style={{ position:'fixed', bottom:32, left:'50%', transform:'translateX(-50%)', background:'#16a34a', color:'#fff', padding:'10px 24px', borderRadius:8, fontWeight:600, zIndex:9999 }}>{message}</div>;
}

function AddRadioDialog({ open, users, saving, onCancel, onSubmit }) {
  const [imei, setImei] = useState('');
  const [serial, setSerial] = useState('');
  const [unitId, setUnitId] = useState('');

  useEffect(() => {
    if (open) { setImei(''); setSerial(''); setUnitId(''); }
  }, [open]);

  if (!open) return null;
  const inputStyle = { width:'100%', boxSizing:'border-box', padding:'9px 10px', borderRadius:6, border:'1px solid var(--dispatch-border)', background:'var(--dispatch-panel-elevated)', color:'var(--dispatch-text)', fontSize:14 };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9998 }}>
      <div style={{ width:440, maxWidth:'calc(100vw - 32px)', background:'var(--dispatch-panel)', border:'1px solid var(--dispatch-border)', borderRadius:10, padding:24, boxShadow:'0 8px 32px rgba(0,0,0,.45)' }}>
        <h3 style={{ margin:'0 0 6px', fontSize:18 }}>Add / Pre-register Radio</h3>
        <p style={{ margin:'0 0 18px', color:'var(--dispatch-text-secondary)', fontSize:13, lineHeight:1.45 }}>
          Enter the IMEI and serial number printed on the radio. When the physical SD7 starts, it will claim this record using the matching serial number.
        </p>
        <label style={{ fontSize:12, fontWeight:700 }}>IMEI</label>
        <input value={imei} onChange={e=>setImei(e.target.value)} style={{...inputStyle, margin:'5px 0 14px'}} placeholder="863460041234567" autoFocus />
        <label style={{ fontSize:12, fontWeight:700 }}>Serial Number</label>
        <input value={serial} onChange={e=>setSerial(e.target.value)} style={{...inputStyle, margin:'5px 0 14px'}} placeholder="SD7A12345" />
        <label style={{ fontSize:12, fontWeight:700 }}>Assigned Unit</label>
        <select value={unitId} onChange={e=>setUnitId(e.target.value)} style={{...inputStyle, marginTop:5}}>
          <option value="">Unassigned</option>
          {users.filter(u=>u.unit_id).map(u=><option key={u.id} value={u.id}>{u.unit_id}</option>)}
        </select>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:22 }}>
          <button onClick={onCancel} disabled={saving} style={{ padding:'8px 14px', borderRadius:6, border:'1px solid var(--dispatch-border)', background:'var(--dispatch-panel-elevated)', color:'var(--dispatch-text)', cursor:'pointer' }}>Cancel</button>
          <button
            onClick={()=>onSubmit({ imei: imei.trim(), serial: serial.trim(), unitId })}
            disabled={saving || !imei.trim() || !serial.trim()}
            style={{ padding:'8px 14px', borderRadius:6, border:'none', background:'#4f46e5', color:'#fff', fontWeight:700, cursor:'pointer', opacity:(saving || !imei.trim() || !serial.trim())?.5:1 }}
          >{saving ? 'Saving…' : 'Add Radio'}</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9998 }}>
      <div style={{ background:'var(--dispatch-panel)', border:'1px solid var(--dispatch-border)', borderRadius:10, padding:28, minWidth:340 }}>
        <h3 style={{ margin:'0 0 10px' }}>{title}</h3>
        <p style={{ color:'var(--dispatch-text-secondary)' }}>{message}</p>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button onClick={onCancel}>Cancel</button>
          <button onClick={onConfirm} style={{ background:'#dc2626', color:'#fff', border:0, borderRadius:6, padding:'8px 14px' }}>Lock Radio</button>
        </div>
      </div>
    </div>
  );
}

export default function RadioManagement({ user }) {
  const navigate = useNavigate();
  const { darkMode, toggleDarkMode } = useTheme();
  const isAdmin = user?.role === 'admin';
  const [radios, setRadios] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({ open:false, radioId:null, radioDisplayId:'' });
  const [savingRows, setSavingRows] = useState({});
  const [pendingSelections, setPendingSelections] = useState({});
  const [kioskDurations, setKioskDurations] = useState({});
  const [nowMs, setNowMs] = useState(Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => { const id=setInterval(()=>setNowMs(Date.now()),5000); return()=>clearInterval(id); }, []);
  const showToast = useCallback(msg => { setToastMsg(msg); setToastVisible(true); setTimeout(()=>setToastVisible(false),2200); }, []);
  const loadData = useCallback(async () => {
    try {
      const [rd, ud] = await Promise.all([getRadios(), getRadioUsers()]);
      setRadios(rd.radios || []); setUsers(ud.users || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(()=>{ loadData(); }, [loadData]);

  const handleAddRadio = useCallback(async data => {
    setAdding(true);
    try {
      const result = await preRegisterRadio(data);
      setAddOpen(false);
      await loadData();
      showToast(result.created ? 'Radio pre-registered' : 'Radio record updated');
    } catch (err) { showToast(`Add failed: ${err.message}`); }
    finally { setAdding(false); }
  }, [loadData, showToast]);

  const handleSubmitAssign = useCallback(async radioId => {
    if (!(radioId in pendingSelections)) return;
    const userId = pendingSelections[radioId] || null;
    setSavingRows(p=>({...p,[radioId]:true}));
    try {
      await assignRadioUnit(radioId, userId, { force:true });
      setPendingSelections(p=>{ const n={...p}; delete n[radioId]; return n; });
      await loadData(); showToast(userId ? 'Assignment updated' : 'Radio unassigned');
    } catch (err) { showToast(`Assign failed: ${err.message}`); }
    finally { setSavingRows(p=>({...p,[radioId]:false})); }
  }, [pendingSelections, loadData, showToast]);

  const doLock = useCallback(async (radioId,isLocked)=>{
    setSavingRows(p=>({...p,[radioId]:true}));
    try { await lockRadio(radioId,isLocked); await loadData(); }
    finally { setSavingRows(p=>({...p,[radioId]:false})); }
  }, [loadData]);

  const handleKioskUnlock = useCallback(async radioId => {
    const n=Number(kioskDurations[radioId]); const min=Number.isFinite(n)&&n>0?Math.floor(n):DEFAULT_KIOSK_UNLOCK_MINUTES;
    setSavingRows(p=>({...p,[radioId]:true}));
    try { await kioskUnlockRadio(radioId,min); await loadData(); showToast(`Kiosk unlocked ${min}m`); }
    catch(err){ showToast(`Unlock failed: ${err.message}`); }
    finally { setSavingRows(p=>({...p,[radioId]:false})); }
  }, [kioskDurations,loadData,showToast]);

  const handleKioskRelock = useCallback(async radioId => {
    setSavingRows(p=>({...p,[radioId]:true}));
    try { await kioskRelockRadio(radioId); await loadData(); showToast('Kiosk re-locked'); }
    catch(err){ showToast(`Re-lock failed: ${err.message}`); }
    finally { setSavingRows(p=>({...p,[radioId]:false})); }
  }, [loadData,showToast]);

  const q=search.toLowerCase();
  const filtered=radios.filter(r=>!q || [r.radio_id,r.imei,r.serial_number,r.assigned_unit_identity,formatLastSeen(r.last_seen)].some(v=>String(v||'').toLowerCase().includes(q)));

  const th={ padding:'10px 12px', textAlign:'left', color:'var(--dispatch-text-tertiary)', fontWeight:700, fontSize:11, textTransform:'uppercase', letterSpacing:'.05em', whiteSpace:'nowrap' };
  const td={ padding:'12px 12px', borderBottom:'1px solid var(--dispatch-border)', whiteSpace:'nowrap' };
  const btn={ padding:'5px 10px', fontSize:12, fontWeight:700, borderRadius:6, border:'none', color:'#fff', cursor:'pointer' };

  return (
    <div className="min-h-screen-safe" style={{ background:'var(--dispatch-bg)', color:'var(--dispatch-text)', fontFamily:'system-ui,-apple-system,sans-serif' }}>
      <header style={{ background:'var(--dispatch-panel)', borderBottom:'1px solid var(--dispatch-border)', padding:'14px 24px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{display:'flex',alignItems:'center',gap:14}}>
          <button onClick={()=>navigate(-1)} style={{padding:'6px 12px',borderRadius:6,border:'1px solid var(--dispatch-border)',background:'var(--dispatch-panel-elevated)',color:'var(--dispatch-text-secondary)',cursor:'pointer'}}>← Back</button>
          <h1 style={{margin:0,fontSize:18}}>Radio Management</h1>
          <span style={{fontSize:13,color:'var(--dispatch-text-tertiary)'}}>{radios.length} {radios.length===1?'device':'devices'}</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:13,color:'var(--dispatch-text-tertiary)'}}>{user?.username}{isAdmin&&<span style={{marginLeft:6,color:'#6366f1',fontWeight:700}}>Admin</span>}</span>
          <button onClick={toggleDarkMode} style={{padding:'6px 10px',borderRadius:6,border:'1px solid var(--dispatch-border)',background:'transparent'}}>{darkMode?'☀️':'🌙'}</button>
        </div>
      </header>

      <div style={{padding:'20px 24px'}}>
        <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:16,flexWrap:'wrap'}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search radios..." style={{width:400,maxWidth:'100%',padding:'9px 14px',background:'var(--dispatch-panel)',border:'1px solid var(--dispatch-border)',borderRadius:8,color:'var(--dispatch-text)',fontSize:14}} />
          {isAdmin && <button onClick={()=>setAddOpen(true)} style={{...btn,background:'#4f46e5',padding:'9px 14px'}}>+ Add Radio</button>}
        </div>

        {loading ? <div style={{padding:60,textAlign:'center'}}>Loading radios…</div> : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:14}}>
              <thead><tr style={{borderBottom:'1px solid var(--dispatch-border)'}}>{['Radio ID','IMEI','Serial #','Status','Assigned Unit','Last Seen','Kiosk','Lock'].map(c=><th key={c} style={th}>{c}</th>)}</tr></thead>
              <tbody>
                {filtered.map(radio=>{
                  const current=String(radio.assigned_unit_id||'');
                  const pending=radio.radio_id in pendingSelections ? pendingSelections[radio.radio_id] : current;
                  const changed=radio.radio_id in pendingSelections;
                  const saving=!!savingRows[radio.radio_id];
                  const remaining=formatRemainingMinutes(radio.kiosk_unlock_expires_at,nowMs);
                  return <tr key={radio.radio_id} style={{background:radio.is_locked?'rgba(220,38,38,.05)':'transparent'}}>
                    <td style={{...td,fontFamily:'monospace',fontWeight:700}}>{radio.radio_id}</td>
                    <td style={{...td,fontFamily:'monospace'}}>{radio.imei||'—'}</td>
                    <td style={{...td,fontFamily:'monospace'}}>{radio.serial_number||'—'}</td>
                    <td style={td}><StatusBadge radio={radio}/></td>
                    <td style={td}><div style={{display:'flex',gap:6}}>
                      <select value={pending} disabled={saving} onChange={e=>setPendingSelections(p=>({...p,[radio.radio_id]:e.target.value}))} style={{padding:'5px 8px',borderRadius:6,border:'1px solid var(--dispatch-border)',background:'var(--dispatch-panel)',color:'var(--dispatch-text)',minWidth:135}}>
                        <option value="">Unassigned</option>{users.filter(u=>u.unit_id).map(u=><option key={u.id} value={u.id}>{u.unit_id}</option>)}
                      </select>
                      <button disabled={!changed||saving} onClick={()=>handleSubmitAssign(radio.radio_id)} style={{...btn,background:'#4f46e5',opacity:(!changed||saving)?.4:1}}>{saving?'Saving…':'Submit'}</button>
                    </div></td>
                    <td style={{...td,color:'var(--dispatch-text-tertiary)',fontSize:13}}>{formatLastSeen(radio.last_seen)}</td>
                    <td style={td}>{remaining ? <div style={{display:'flex',gap:6,alignItems:'center'}}><span style={{fontSize:12,color:'#15803d',fontWeight:700}}>Unlocked · {remaining}</span><button disabled={saving} onClick={()=>handleKioskRelock(radio.radio_id)} style={{...btn,background:'#b45309'}}>Re-lock</button></div> : <div style={{display:'flex',gap:5,alignItems:'center'}}><input type="number" min="1" max="240" placeholder="15" value={kioskDurations[radio.radio_id]??''} onChange={e=>setKioskDurations(p=>({...p,[radio.radio_id]:e.target.value}))} style={{width:50,padding:'5px 7px',borderRadius:6,border:'1px solid var(--dispatch-border)',background:'var(--dispatch-panel)',color:'var(--dispatch-text)'}}/><span style={{fontSize:11}}>min</span><button disabled={saving} onClick={()=>handleKioskUnlock(radio.radio_id)} style={{...btn,background:'#0369a1'}}>Unlock kiosk</button></div>}</td>
                    <td style={td}><button disabled={!isAdmin||saving} onClick={()=>radio.is_locked?doLock(radio.radio_id,false):setConfirmDialog({open:true,radioId:radio.radio_id,radioDisplayId:radio.radio_id})} style={{...btn,background:radio.is_locked?'#15803d':'#991b1b',opacity:(!isAdmin||saving)?.4:1}}>{radio.is_locked?'Unlock':'Lock'}</button></td>
                  </tr>;
                })}
              </tbody>
            </table>
            {!filtered.length && <div style={{padding:50,textAlign:'center',color:'var(--dispatch-text-tertiary)'}}>{radios.length?'No radios match your search.':'No radios registered yet.'}</div>}
          </div>
        )}
      </div>

      <Toast message={toastMsg} visible={toastVisible}/>
      <AddRadioDialog open={addOpen} users={users} saving={adding} onCancel={()=>setAddOpen(false)} onSubmit={handleAddRadio}/>
      <ConfirmDialog open={confirmDialog.open} title={`Lock radio ${confirmDialog.radioDisplayId}?`} message="This will immediately disconnect it from the network." onConfirm={()=>{const id=confirmDialog.radioId;setConfirmDialog({open:false,radioId:null,radioDisplayId:''});doLock(id,true);}} onCancel={()=>setConfirmDialog({open:false,radioId:null,radioDisplayId:''})}/>
    </div>
  );
}
