import { useState, useEffect } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { getPatches, createPatch, updatePatch } from '../../utils/api.js';

export default function PatchPanel() {
  const { channels, addEvent } = useDispatchStore();
  const [patches, setPatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sourceChannel, setSourceChannel] = useState('');
  const [targetChannel, setTargetChannel] = useState('');
  const [patchName, setPatchName] = useState('');

  const fetchPatches = async () => {
    try {
      setLoading(true);
      const data = await getPatches();
      setPatches(data.patches || []);
    } catch (error) {
      console.error('Failed to fetch patches:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPatches();
  }, []);

  const handleCreatePatch = async () => {
    if (!sourceChannel || !targetChannel) return;
    
    try {
      const name = patchName || `${sourceChannel} → ${targetChannel}`;
      await createPatch(name, parseInt(sourceChannel), parseInt(targetChannel), true);
      addEvent({
        type: 'patch_enabled',
        message: `Patch created: ${name}`,
      });
      fetchPatches();
      setSourceChannel('');
      setTargetChannel('');
      setPatchName('');
    } catch (error) {
      console.error('Failed to create patch:', error);
    }
  };

  const handleTogglePatch = async (patch) => {
    try {
      await updatePatch(patch.id, { is_enabled: !patch.is_enabled });
      addEvent({
        type: patch.is_enabled ? 'patch_disabled' : 'patch_enabled',
        message: `Patch ${patch.name} ${patch.is_enabled ? 'disabled' : 'enabled'}`,
      });
      fetchPatches();
    } catch (error) {
      console.error('Failed to toggle patch:', error);
    }
  };

  const getChannelName = (id) => {
    const channel = channels.find(c => c.id === id);
    return channel?.name || `Channel ${id}`;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-dispatch-text uppercase tracking-wide">Patches</h2>
        <button
          onClick={fetchPatches}
          disabled={loading}
          className="text-xs text-dispatch-secondary hover:text-dispatch-text transition-colors"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="space-y-2 mb-4">
        <input
          type="text"
          value={patchName}
          onChange={(e) => setPatchName(e.target.value)}
          placeholder="Patch name (optional)"
          className="w-full px-2 py-1.5 text-xs bg-dispatch-panel border border-dispatch-border rounded text-dispatch-text placeholder-dispatch-secondary focus:outline-none focus:border-blue-500"
        />
        <select
          value={sourceChannel}
          onChange={(e) => setSourceChannel(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-dispatch-panel border border-dispatch-border rounded text-dispatch-text focus:outline-none focus:border-blue-500"
        >
          <option value="">Source Channel</option>
          {channels.map(ch => (
            <option key={ch.id} value={ch.id}>{ch.name}</option>
          ))}
        </select>
        <select
          value={targetChannel}
          onChange={(e) => setTargetChannel(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-dispatch-panel border border-dispatch-border rounded text-dispatch-text focus:outline-none focus:border-blue-500"
        >
          <option value="">Target Channel</option>
          {channels.map(ch => (
            <option key={ch.id} value={ch.id}>{ch.name}</option>
          ))}
        </select>
        <button
          onClick={handleCreatePatch}
          disabled={!sourceChannel || !targetChannel}
          className="w-full px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create Patch
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
        {patches.length === 0 ? (
          <div className="text-xs text-dispatch-secondary text-center py-4">
            No patches configured
          </div>
        ) : (
          patches.map(patch => (
            <div
              key={patch.id}
              className={`p-2 rounded text-sm ${
                patch.is_enabled 
                  ? 'bg-purple-900/50 border border-purple-600' 
                  : 'bg-dispatch-panel'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-dispatch-text text-xs">{patch.name}</span>
                <button
                  onClick={() => handleTogglePatch(patch)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    patch.is_enabled 
                      ? 'bg-green-600 text-white' 
                      : 'bg-dispatch-border text-dispatch-secondary'
                  }`}
                >
                  {patch.is_enabled ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="text-xs text-dispatch-secondary">
                {getChannelName(patch.source_channel_id)} → {getChannelName(patch.target_channel_id)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
