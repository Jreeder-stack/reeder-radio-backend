import { useState, useEffect } from 'react';
import { X, Loader2, MessageSquare, Send, ChevronLeft, RefreshCw } from 'lucide-react';

export function MessagesWidget({ show, onClose }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (show) {
      fetchConversations();
    }
  }, [show]);

  const fetchConversations = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cad/chats', { credentials: 'include' });
      const data = await response.json();
      if (response.ok) {
        setConversations(data.chats || []);
      } else {
        setError(data.message || 'Failed to load messages');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const openConversation = async (conversation) => {
    setSelectedConversation(conversation);
    setMessagesLoading(true);
    try {
      const response = await fetch(`/api/cad/chats/${conversation.id}/messages`, { credentials: 'include' });
      const data = await response.json();
      if (response.ok) {
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error('Failed to load conversation:', err);
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleSend = async () => {
    if (!replyText.trim() || !selectedConversation) return;
    setSending(true);
    try {
      const response = await fetch(`/api/cad/chats/${selectedConversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: replyText.trim(),
        }),
      });
      if (response.ok) {
        setReplyText('');
        openConversation(selectedConversation);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setSelectedConversation(null);
    setMessages([]);
    setReplyText('');
    onClose();
  };

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-black flex items-center justify-between">
          {selectedConversation ? (
            <>
              <button onClick={() => setSelectedConversation(null)} className="text-black">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <h2 className="text-black font-mono font-bold uppercase tracking-wider flex-1 text-center">
                {selectedConversation.name || 'Conversation'}
              </h2>
            </>
          ) : (
            <h2 className="text-black font-mono font-bold uppercase tracking-wider flex-1">Messages</h2>
          )}
          <div className="flex items-center gap-2">
            <button onClick={fetchConversations} className="text-gray-500 hover:text-black">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={handleClose} className="text-black">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <p className="text-red-600">{error}</p>
              <button
                onClick={fetchConversations}
                className="mt-4 px-4 py-2 bg-cyan-600 text-white rounded"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && !selectedConversation && (
            <>
              {conversations.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No messages</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {conversations.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => openConversation(conv)}
                      className="w-full p-3 text-left hover:bg-gray-50 flex items-start gap-3"
                    >
                      <div className="flex-shrink-0 w-10 h-10 bg-cyan-100 rounded-full flex items-center justify-center">
                        <MessageSquare className="w-5 h-5 text-cyan-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-black text-sm">{conv.name || conv.id}</span>
                          {conv.unread > 0 && (
                            <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                              {conv.unread}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-600 truncate">{conv.lastMessage}</p>
                        <p className="text-xs text-gray-400">{formatTime(conv.lastMessageAt)}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {selectedConversation && (
            <>
              {messagesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <div className="p-3 space-y-3">
                  {messages.map((msg, index) => (
                    <div
                      key={msg.id || index}
                      className={`flex ${msg.isOutgoing ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[80%] p-2 rounded-lg ${
                          msg.isOutgoing
                            ? 'bg-cyan-600 text-white'
                            : 'bg-gray-100 text-black'
                        }`}
                      >
                        <p className="text-sm">{msg.text}</p>
                        <p className={`text-xs mt-1 ${msg.isOutgoing ? 'text-cyan-200' : 'text-gray-400'}`}>
                          {formatTime(msg.timestamp)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {selectedConversation && (
          <div className="p-3 border-t border-gray-200 flex gap-2">
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 p-2 border border-gray-300 rounded text-black text-sm"
              onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            />
            <button
              onClick={handleSend}
              disabled={sending || !replyText.trim()}
              className="px-3 py-2 bg-cyan-600 text-white rounded disabled:opacity-50"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
