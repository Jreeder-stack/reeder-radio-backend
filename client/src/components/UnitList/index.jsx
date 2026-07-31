import { useEffect, useMemo, useState } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { useSignalingContext } from '../../context/SignalingContext.jsx';
import PageModal from '../PageModal/index.jsx';

function StatusDot({ status, isEmergency }) {
  const isOffline = status === 'offline';
  const color = isEmergency
    ? 'bg-red-500'
    : isOffline
      ? 'bg-gray-500'
      : status === 'transmitting'
        ? 'bg-yellow-500'
        : 'bg-green-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color} ${isEmergency ? 'animate-pulse' : ''} ${isOffline ? 'opacity-50' : ''}`} />;
}

function formatLastSeen(timestamp) {
  if (!timestamp) return 'Never connected';
  const date = new Date(timestamp);
  return date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function LocationIcon({ tracking }) {
  return (
    <svg className={`w-3.5 h-3.5 ${tracking ? 'text-green-400 animate-pulse' : 'text-dispatch-secondary'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export default function UnitList() {
  const { units } = useDispatchStore();
  const { trackedUnits, emitTrackStart, emitTrackStop } = useSignalingContext();
  const [pageTarget, setPageTarget] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [lists, setLists] = useState([]);
  const [selectedListId, setSelectedListId] = useState('');
  const [listName, setListName] = useState('');
  const [showLists, setShowLists] = useState(false);
  const [listBusy, setListBusy] = useState(false);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const selectedList = lists.find(list => String(list.id) === String(selectedListId));

  const loadLists = async () => {
    try {
      const res = await fetch('/api/dispatch/paging-lists', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setLists(data.lists || []);
    } catch (err) {
      console.error('[UnitList] Failed to load paging lists:', err);
    }
  };

  useEffect(() => {
    loadLists();
  }, []);

  useEffect(() => {
    const validIds = new Set(units.map(unit => Number(unit.radio_pk || unit.id)));
    setSelected(previous => new Set(Array.from(previous).filter(id => validIds.has(id))));
  }, [units]);

  const isTracked = identity => typeof trackedUnits?.has === 'function'
    ? trackedUnits.has(identity)
    : trackedUnits?.includes?.(identity);

  const handleToggleTracking = unitIdentity => {
    if (isTracked(unitIdentity)) emitTrackStop(unitIdentity);
    else emitTrackStart(unitIdentity);
  };

  const toggleSelected = radioPk => {
    const id = Number(radioPk);
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loadSelectedList = () => {
    if (!selectedList) return;
    setSelected(new Set((selectedList.memberRadioIds || []).map(Number)));
    setListName(selectedList.name || '');
  };

  const saveNewList = async () => {
    if (!listName.trim()) return alert('Enter a name for the paging list.');
    if (selectedIds.length === 0) return alert('Select at least one radio first.');
    setListBusy(true);
    try {
      const res = await fetch('/api/dispatch/paging-lists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: listName.trim(), radioIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to save list');
      setLists(data.lists || []);
      setListName('');
    } catch (err) {
      alert(err.message);
    } finally {
      setListBusy(false);
    }
  };

  const updateList = async () => {
    if (!selectedList || selectedList.protected) return;
    if (selectedIds.length === 0) return alert('Select at least one radio first.');
    setListBusy(true);
    try {
      const res = await fetch(`/api/dispatch/paging-lists/${selectedList.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: listName.trim() || selectedList.name, radioIds: selectedIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to update list');
      setLists(data.lists || []);
    } catch (err) {
      alert(err.message);
    } finally {
      setListBusy(false);
    }
  };

  const deleteList = async () => {
    if (!selectedList || selectedList.protected) return;
    if (!window.confirm(`Delete paging list “${selectedList.name}”?`)) return;
    setListBusy(true);
    try {
      const res = await fetch(`/api/dispatch/paging-lists/${selectedList.id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to delete list');
      setLists(data.lists || []);
      setSelectedListId('');
      setListName('');
    } catch (err) {
      alert(err.message);
    } finally {
      setListBusy(false);
    }
  };

  const pageSelected = () => {
    if (selectedIds.length === 0) return;
    setPageTarget({ type: 'units', id: 'selected', radioIds: selectedIds, label: `${selectedIds.length} selected radio${selectedIds.length === 1 ? '' : 's'}` });
  };

  const pageSavedList = () => {
    if (!selectedList) return;
    setPageTarget({ type: 'list', id: selectedList.id, label: `${selectedList.name} — ${(selectedList.memberRadioIds || []).length} radios` });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-sm font-bold text-dispatch-text uppercase tracking-wide">Radios</h2>
          <span className="text-[11px] text-dispatch-secondary">{units.length} activated</span>
        </div>
        <button onClick={() => setShowLists(value => !value)} className="text-xs px-2 py-1 rounded bg-dispatch-border text-dispatch-text hover:bg-dispatch-border/70">LISTS</button>
      </div>

      {showLists && (
        <div className="mb-2 p-2 rounded-md border border-dispatch-border bg-dispatch-surface space-y-2">
          <select
            value={selectedListId}
            onChange={e => {
              setSelectedListId(e.target.value);
              const list = lists.find(item => String(item.id) === e.target.value);
              setListName(list?.name || '');
            }}
            className="w-full text-xs rounded border border-dispatch-border bg-dispatch-bg text-dispatch-text px-2 py-1.5"
          >
            <option value="">Choose saved list...</option>
            {lists.map(list => <option key={list.id} value={list.id}>{list.name} ({list.memberRadioIds?.length || 0}){list.protected ? ' — System' : ''}</option>)}
          </select>
          <div className="flex gap-1">
            <button disabled={!selectedList} onClick={loadSelectedList} className="flex-1 text-[11px] px-2 py-1 rounded bg-dispatch-border text-dispatch-text disabled:opacity-40">LOAD</button>
            <button disabled={!selectedList} onClick={pageSavedList} className="flex-1 text-[11px] px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-40">PAGE LIST</button>
          </div>
          <input value={listName} onChange={e => setListName(e.target.value)} placeholder="New list name" className="w-full text-xs rounded border border-dispatch-border bg-dispatch-bg text-dispatch-text px-2 py-1.5" />
          <div className="grid grid-cols-3 gap-1">
            <button disabled={listBusy || !listName.trim()} onClick={saveNewList} className="text-[11px] px-1 py-1 rounded bg-green-700 text-white disabled:opacity-40">SAVE NEW</button>
            <button disabled={listBusy || !selectedList || selectedList.protected} onClick={updateList} className="text-[11px] px-1 py-1 rounded bg-blue-700 text-white disabled:opacity-40">UPDATE</button>
            <button disabled={listBusy || !selectedList || selectedList.protected} onClick={deleteList} className="text-[11px] px-1 py-1 rounded bg-red-700 text-white disabled:opacity-40">DELETE</button>
          </div>
        </div>
      )}

      {pageTarget && <PageModal target={pageTarget} onClose={() => setPageTarget(null)} />}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1 scrollbar-thin pb-2">
        {units.length === 0 ? (
          <div className="text-xs text-dispatch-secondary text-center py-4">No activated radios found</div>
        ) : units.map(unit => {
          const radioPk = Number(unit.radio_pk || unit.id);
          const isOffline = unit.status === 'offline';
          const tracking = isTracked(unit.unit_identity);
          return (
            <div key={radioPk} className={`unit-card p-2 rounded-md text-sm transition-all ${unit.is_emergency ? 'unit-card-emergency' : ''} ${selected.has(radioPk) ? 'ring-1 ring-amber-500' : ''}`}>
              <div className="flex items-start gap-2">
                <input type="checkbox" checked={selected.has(radioPk)} onChange={() => toggleSelected(radioPk)} className="mt-1 accent-amber-600" aria-label={`Select ${unit.unit_identity}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status={unit.status} isEmergency={unit.is_emergency} />
                      <span className={`font-medium truncate ${isOffline ? 'text-dispatch-secondary' : 'text-dispatch-text'}`}>{unit.unit_identity}</span>
                      {tracking && <LocationIcon tracking />}
                    </div>
                    <span className="text-[10px] text-dispatch-tertiary whitespace-nowrap">{formatLastSeen(unit.last_seen)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-1.5 gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] text-dispatch-secondary truncate">{unit.channel || (isOffline ? 'Offline' : 'No channel')}</div>
                      <div className="text-[10px] text-dispatch-tertiary">Radio {unit.radio_id}{unit.is_locked ? ' • LOCKED' : ''}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isOffline && <button onClick={() => handleToggleTracking(unit.unit_identity)} className={`text-[10px] px-1.5 py-0.5 rounded ${tracking ? 'bg-green-600/30 text-green-400' : 'bg-dispatch-border text-dispatch-secondary'}`}><LocationIcon tracking={tracking} /></button>}
                      <button onClick={() => setPageTarget({ type: 'unit', id: unit.unit_identity, label: unit.unit_identity })} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600 text-white">PAGE</button>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dispatch-border text-dispatch-secondary">{isOffline ? 'OFFLINE' : (unit.status || 'ONLINE').toUpperCase()}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 pt-2 border-t border-dispatch-border bg-dispatch-bg">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-dispatch-text">{selectedIds.length} SELECTED</span>
          <button onClick={() => setSelected(new Set())} disabled={selectedIds.length === 0} className="text-[11px] text-dispatch-secondary hover:text-dispatch-text disabled:opacity-40">CLEAR</button>
        </div>
        <button onClick={pageSelected} disabled={selectedIds.length === 0} className="w-full py-2 rounded-md bg-amber-600 text-white text-xs font-bold hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed">PAGE SELECTED</button>
      </div>
    </div>
  );
}
