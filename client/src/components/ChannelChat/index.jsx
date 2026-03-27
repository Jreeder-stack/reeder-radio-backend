import { useState, useEffect, useRef, useCallback } from 'react';
import { getChannelMessages, sendTextMessage, transcribeMessage } from '../../utils/api.js';
import { livekitManager } from '../../audio/LiveKitManager.js';
import VoiceMessage from './VoiceMessage.jsx';

export default function ChannelChat({ channel, currentUser, onNewMessage }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const prevMessageCountRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!channel) return;
    try {
      const data = await getChannelMessages(channel, 50, 0);
      setMessages(data.messages || []);
    } catch (error) {
      console.error('[ChannelChat] Failed to fetch messages:', error);
    }
  }, [channel]);

  useEffect(() => {
    if (channel) {
      prevMessageCountRef.current = 0;
      setLoading(true);
      fetchMessages().finally(() => setLoading(false));

      pollIntervalRef.current = setInterval(fetchMessages, 10000);
      
      const handleDataReceived = (channelName, data) => {
        if (channelName === channel && data.type === 'new_message') {
          setMessages(prev => {
            const exists = prev.some(m => m.id === data.message.id);
            if (exists) return prev;
            return [...prev, data.message];
          });
        }
      };
      
      const removeListener = livekitManager.addDataReceivedListener(handleDataReceived);
      
      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        removeListener();
      };
    }
  }, [channel, fetchMessages]);

  useEffect(() => {
    const currentCount = messages.length;
    if (currentCount > prevMessageCountRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = currentCount;
  }, [messages, scrollToBottom]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || sending) return;

    setSending(true);
    try {
      const result = await sendTextMessage(channel, inputText.trim());
      if (result.success) {
        setInputText('');
        setMessages(prev => [...prev, result.message]);
        if (onNewMessage) onNewMessage(result.message);
      }
    } catch (error) {
      console.error('[ChannelChat] Failed to send message:', error);
    } finally {
      setSending(false);
    }
  };

  const handleTranscribe = async (messageId) => {
    try {
      const result = await transcribeMessage(messageId);
      if (result.success) {
        setMessages(prev => prev.map(msg => 
          msg.id === messageId ? { ...msg, transcription: result.message.transcription } : msg
        ));
      }
    } catch (error) {
      console.error('[ChannelChat] Transcription failed:', error);
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const isOwnMessage = (sender) => {
    return sender === currentUser?.unit_id || sender === currentUser?.username;
  };

  if (!channel) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
        Select a channel to view messages
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-100 dark:bg-gray-900">
      <div className="px-4 py-2 bg-gray-200 dark:bg-gray-800 border-b border-gray-300 dark:border-gray-700">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200">{channel} Chat</h3>
      </div>

      <div 
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            Loading messages...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
            No messages yet
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${isOwnMessage(msg.sender) ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 ${
                  isOwnMessage(msg.sender)
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow'
                }`}
              >
                {!isOwnMessage(msg.sender) && (
                  <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 mb-1">
                    {msg.sender}
                  </div>
                )}

                {msg.message_type === 'audio' ? (
                  <VoiceMessage
                    audioUrl={msg.audio_url}
                    duration={msg.audio_duration}
                    transcription={msg.transcription}
                    onTranscribe={() => handleTranscribe(msg.id)}
                    isOwn={isOwnMessage(msg.sender)}
                  />
                ) : (
                  <div className="text-sm">{msg.content}</div>
                )}

                <div className={`text-xs mt-1 ${
                  isOwnMessage(msg.sender) ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'
                }`}>
                  {formatTime(msg.created_at)}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="p-3 bg-white dark:bg-gray-800 border-t border-gray-300 dark:border-gray-700">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 px-3 py-2 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={!inputText.trim() || sending}
            className="px-4 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
