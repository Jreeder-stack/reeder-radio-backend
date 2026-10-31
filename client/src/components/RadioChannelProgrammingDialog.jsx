import { useEffect, useState } from 'react';
import { getRadioChannels, saveRadioChannels } from '../utils/radiosApi.js';

/**
 * Custom channel programming is a subset of the assigned user's permissions.
 * The server revalidates every selected ID; this dialog never grants access.
 */
export default function RadioChannelProgrammingDialog({ radio, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [authorized, setAuthorized] = useState([]);
  const [custom, setCustom] = useState(false);
  const [selected, setSelected] = useState([]);
  const [unit, setUnit] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    if (!radio?.radio_id) return () => { active = false; };
    getRadioChannels(radio.radio_id).then(data => {
      if (!active) return;
      setAuthorized(data.authorizedChannels || []);
      setSelected(data.channelIds || []);
      setCustom(data.custom === true);
      setUnit(data.unitIdentity || '');
    }).catch(err => {
      if (active) setError(err.message || 'Unable to load programming');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [radio?.radio_id]);

  if (!radio) return null;

  const toggle = id => setSelected(old => old.includes(id)
    ? old.filter(x => x !== id)
    : [...old, id]);
  const move = (id, delta) => setSelected(old => {
    const idx = old.indexOf(id);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= old.length) return old;
    const updated = old.slice();
    [updated[idx], updated[next]] = [updated[next], updated[idx]];
    return updated;
  });
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await saveRadioChannels(radio.radio_id, custom ? selected : null);
      await onSaved();
    } catch (err) {
      setError(err.message || 'Unable to save programming');
    } finally {
      setSaving(false);
    }
  };
  const selectedChannels = selected.map(id => authorized.find(ch => ch.id === id)).filter(Boolean);
  const remaining = authorized.filter(ch => !selected.includes(ch.id));
  const button = {
    color:'var(--dispatch-text)', background:'var(--dispatch-panel-elevated)',
    border:'1px solid var(--dispatch-border)', borderRadius:6,
    padding:'6px 10px', cursor:'pointer'
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Program radio channels"
      style={{position:'fixed',inset:0,display:'flex',alignItems:'center',justifyContent:'center',
        background:'rgba(0,0,0,.7)',zIndex:10000,padding:16}}>
      <div style={{width:560,maxWidth:'100%',maxHeight:'90vh',overflowY:'auto',
        borderRadius:12,padding:22,color:'var(--dispatch-text)',
        background:'var(--dispatch-panel)',border:'1px solid var(--dispatch-border)'}}>
        <h3 style={{margin:'0 0 6px'}}>Program channels: Radio {radio.radio_id}</h3>
        <p style={{margin:'0 0 16px',fontSize:13,color:'var(--dispatch-text-secondary)'}}>
          Assigned unit: {unit || radio.assigned_unit_identity || 'Unassigned'}.
          Selected channels download to this radio and remain visible offline.
          Transmitting still requires an authenticated connection.
        </p>
        {loading ? <p>Loading authorized channels...</p> : (
          <>
            <label style={{display:'block',marginBottom:10}}>
              <input type="radio" name="channel-programming-mode" checked={!custom}
                onChange={()=>setCustom(false)} disabled={saving}/>
              {' '}Use all channels assigned to this unit (automatic)
            </label>
            <label style={{display:'block',marginBottom:14}}>
              <input type="radio" name="channel-programming-mode" checked={custom}
                onChange={()=>setCustom(true)} disabled={saving}/>
              {' '}Custom channels for this radio
            </label>
            {custom && (
              <>
                <p style={{fontSize:12,color:'var(--dispatch-text-secondary)'}}>
                  Check the channels to program. Use ↑ / ↓ to set knob order within each zone.
                  Leaving all unchecked means this radio has no channels.
                </p>
                <div style={{maxHeight:310,overflowY:'auto',border:'1px solid var(--dispatch-border)',
                  borderRadius:6,padding:10}}>
                  {[...selectedChannels, ...remaining].map(ch => {
                    const checked = selected.includes(ch.id);
                    const index = selected.indexOf(ch.id);
                    return (
                      <div key={ch.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 4px',
                        borderBottom:'1px solid var(--dispatch-border)'}}>
                        <label style={{flex:1,fontSize:13}}>
                          <input type="checkbox" disabled={saving} checked={checked}
                            onChange={()=>toggle(ch.id)}/>
                          {' '}{ch.zone || 'Default'} / {ch.name}
                        </label>
                        {checked && (
                          <>
                            <button disabled={saving || index===0} onClick={()=>move(ch.id,-1)}
                              style={button} aria-label={'Move '+ch.name+' up'}>↑</button>
                            <button disabled={saving || index===selected.length-1}
                              onClick={()=>move(ch.id,1)} style={button}
                              aria-label={'Move '+ch.name+' down'}>↓</button>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {!authorized.length && <p>No channels are assigned to this unit.</p>}
                </div>
              </>
            )}
            <p style={{fontSize:12,color:'var(--dispatch-text-secondary)',marginTop:12}}>
              Programming changes synchronize when the radio reconnects.
              An offline radio keeps its last successfully received lineup until contact is restored.
            </p>
          </>
        )}
        {error && <p role="alert" style={{color:'#ef4444',fontSize:13}}>{error}</p>}
        <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:16}}>
          <button disabled={saving} onClick={onClose} style={button}>Cancel</button>
          <button disabled={loading || saving || !!error && !authorized.length}
            onClick={save} style={{...button,background:'#1d4ed8',color:'white'}}>
            {saving ? 'Saving...' : 'Save radio lineup'}
          </button>
        </div>
      </div>
    </div>
  );
}
