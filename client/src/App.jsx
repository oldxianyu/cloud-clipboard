import React from 'react';
import { Button, Dropdown, Input, Modal, Progress, Space, Tag, Tooltip, Typography, message } from 'antd';
import { Bubble, Sender, Welcome } from '@ant-design/x';
import { BulbOutlined, ClearOutlined, CloudUploadOutlined, CopyOutlined, DesktopOutlined, FileOutlined, MoonOutlined, PaperClipOutlined, SendOutlined, SettingOutlined, SunOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Text, Title } = Typography;
const MAX_FILE = 10 * 1024 ** 3;
const CHUNK_SIZE = 2 * 1024 ** 2;
const formatSize = n => { if (n == null) return ''; const u = ['B','KB','MB','GB','TB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return `${n.toFixed(i?1:0)} ${u[i]}`; };
const roomFromUrl = () => new URLSearchParams(location.hash.split('?')[1] || location.search.slice(1)).get('room') || '';

export default function ClipboardApp({ dark, onToggleTheme }) {
  const [messageApi, messageContext] = message.useMessage();
  const [room, setRoom] = React.useState(roomFromUrl);
  const [draft, setDraft] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [status, setStatus] = React.useState('connecting');
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [resumeInfo, setResumeInfo] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [archiveEntries, setArchiveEntries] = React.useState(null);
  const [roomModal, setRoomModal] = React.useState(false);
  const [roomDraft, setRoomDraft] = React.useState(room);
  const wsRef = React.useRef(null);
  const bottomRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const roomRef = React.useRef(room);
  roomRef.current = room;

  const api = React.useCallback(async (path, options={}) => {
    const response = await fetch(`/${path}${path.includes('?') ? '&' : '?'}room=${encodeURIComponent(roomRef.current)}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.code && data.code >= 400)) throw new Error(data.msg || `HTTP ${response.status}`);
    return data;
  }, []);

  React.useEffect(() => {
    let stopped = false; let ws;
    const connect = async () => {
      try {
        setStatus('connecting');
        const config = await fetch('/server').then(r => r.json());
        const wsUrl = new URL(config.server, location.href);
        wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl.port = location.port;
        wsUrl.searchParams.set('room', roomRef.current);
        ws = new WebSocket(wsUrl); wsRef.current = ws;
        ws.onopen = () => !stopped && setStatus('online');
        ws.onclose = () => { if (!stopped) { setStatus('offline'); setTimeout(connect, 1800); } };
        ws.onerror = () => ws.close();
        ws.onmessage = e => { try { const m=JSON.parse(e.data); if(m.event==='receive') setItems(v=>[m.data,...v.filter(x=>x.id!==m.data.id)]); if(m.event==='receiveMulti') setItems(m.data.slice().reverse()); if(m.event==='revoke') setItems(v=>v.filter(x=>x.id!==m.data.id)); } catch {} };
      } catch { if (!stopped) { setStatus('offline'); setTimeout(connect, 2500); } }
    };
    connect(); return () => { stopped=true; ws?.close(); };
  }, [room]);

  React.useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [items.length]);
  React.useEffect(() => { const onHash=()=>setRoom(roomFromUrl()); window.addEventListener('hashchange',onHash); return()=>window.removeEventListener('hashchange',onHash); }, []);

  const sendText = async value => {
    const content = value.trimEnd(); if (!content.trim()) return;
    setBusy(true);
    try { await api('text', { method:'POST', headers:{'Content-Type':'text/plain;charset=UTF-8'}, body:content }); setDraft(''); }
    catch(e) { messageApi.error(`发送失败：${e.message}`); }
    finally { setBusy(false); }
  };

  const uploadFiles = async fileList => {
    const files = Array.from(fileList || []); if (!files.length) return;
    if (files.some(f=>f.size>MAX_FILE)) { messageApi.error('单个文件不能超过 10 GiB'); return; }
    setBusy(true); setProgress(0);
    try {
      for (const file of files) {
        const sessions = JSON.parse(localStorage.getItem('clipboard-upload-sessions') || '{}');
        const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
        let uuid = sessions[fingerprint]; let offset = 0;
        if (uuid) {
          const statusResponse = await fetch(`/upload/chunk/${uuid}`);
          if (statusResponse.ok) offset = (await statusResponse.json()).result.offset || 0;
          else { uuid = null; delete sessions[fingerprint]; }
        }
        if (!uuid) {
          const init=await fetch(`/upload/chunk?room=${encodeURIComponent(roomRef.current)}`, {method:'POST',headers:{'Content-Type':'text/plain'},body:file.name}).then(r=>r.json());
          uuid = init.result.uuid; sessions[fingerprint] = uuid; localStorage.setItem('clipboard-upload-sessions', JSON.stringify(sessions));
        }
        setResumeInfo(offset ? `已恢复 ${formatSize(offset)} 上传进度` : null);
        while(offset<file.size) {
          const part=file.slice(offset,offset+CHUNK_SIZE);
          const r=await fetch(`/upload/chunk/${uuid}?room=${encodeURIComponent(roomRef.current)}&offset=${offset}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:part});
          if(!r.ok) throw new Error((await r.json().catch(()=>({}))).msg||`上传失败 HTTP ${r.status}`);
          offset+=part.size; setProgress(Math.round(offset/file.size*100));
        }
        const done=await fetch(`/upload/finish/${uuid}?room=${encodeURIComponent(roomRef.current)}`,{method:'POST'});
        if(!done.ok) throw new Error('文件结束请求失败');
        delete sessions[fingerprint]; localStorage.setItem('clipboard-upload-sessions', JSON.stringify(sessions));
      }
    } catch(e) { messageApi.error(`上传失败：${e.message}`); }
    finally { setBusy(false); setProgress(0); setResumeInfo(null); if(fileRef.current) fileRef.current.value=''; }
  };

  const clearHistory = () => Modal.confirm({ title:'清空当前房间？', content:'该房间内的剪贴板消息将被移除。', okText:'清空', cancelText:'取消', okButtonProps:{danger:true}, onOk:()=>api('revoke/all',{method:'DELETE'}) });
  const joinRoom = () => { const next=roomDraft.trim(); setRoom(next); location.hash = next ? `/?room=${encodeURIComponent(next)}` : '/'; setRoomModal(false); };
  const onPaste = e => { const files=Array.from(e.clipboardData?.files||[]); if(files.length) {e.preventDefault(); uploadFiles(files);} };
  const onDrop = e => { e.preventDefault(); uploadFiles(e.dataTransfer.files); };
  const onDrag = e => e.preventDefault();
  const openPreview = async item => {
    setPreview(item); setArchiveEntries(null);
    if (/\\.(zip|cbz)$/i.test(item.name)) {
      try {
        const response = await fetch(`/preview/archive/${item.cache}/${encodeURIComponent(item.name)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || '无法读取压缩包内容');
        setArchiveEntries(data.entries || []);
      } catch (error) { messageApi.error(error.message); }
    }
  };
  const actions = [
    { key:'copy', label:'复制内容', icon:<CopyOutlined/>, onClick:async item=>{ if(item.type==='text') await navigator.clipboard.writeText(new DOMParser().parseFromString(item.content,'text/html').documentElement.textContent); else await navigator.clipboard.writeText(`${location.origin}/file/${item.cache}/${encodeURIComponent(item.name)}`); } },
    { key:'delete', label:'删除消息', danger:true, onClick:item=>api(`revoke/${item.id}`,{method:'DELETE'}) },
  ];
  const content = item => item.type==='file' ? <div className="file-bubble"><FileOutlined className="file-icon"/><div className="file-meta"><Text strong ellipsis>{item.name}</Text><Text type="secondary">{formatSize(item.size)} · {item.expire ? `有效至 ${dayjs(item.expire*1000).format('MM-DD HH:mm')}` : '文件'}</Text></div><Space><Button type="link" onClick={()=>openPreview(item)}>预览</Button><Button type="link" href={`/file/${item.cache}/${encodeURIComponent(item.name)}`} download={item.name}>下载</Button></Space></div> : <div className="text-bubble"><div className="message-text">{new DOMParser().parseFromString(item.content,'text/html').documentElement.textContent}</div><Button type="text" size="small" icon={<CopyOutlined/>} onClick={()=>navigator.clipboard.writeText(new DOMParser().parseFromString(item.content,'text/html').documentElement.textContent)}>复制</Button></div>;

  return <div className={`workspace ${dark?'dark':''}`} onPaste={onPaste} onDragOver={onDrag} onDrop={onDrop}>{messageContext}
    <header className="topbar"><div className="brand-mark"><ThunderboltOutlined/></div><div className="brand-copy"><b>云剪贴板</b><span>让内容，即刻抵达</span></div><div className="topbar-spacer"/><Tag color={status==='online'?'green':status==='connecting'?'gold':'red'} className="status-tag"><i/> {status==='online'?'实时同步':status==='connecting'?'正在连接':'连接中断'}</Tag><Button type="text" icon={dark?<SunOutlined/>:<MoonOutlined/>} onClick={onToggleTheme} aria-label="切换主题"/><Dropdown menu={{items:[{key:'room',label:'切换房间',icon:<DesktopOutlined/>,onClick:()=>{setRoomDraft(room);setRoomModal(true)}},{key:'clear',label:'清空当前房间',icon:<ClearOutlined/>,danger:true,onClick:clearHistory}]}}><Button type="text" icon={<SettingOutlined/>}/></Dropdown><div className="user-dot">你</div></header>
    <main className="chat-area">
      <div className="conversation-head"><div><Text type="secondary" className="eyebrow">SHARED SPACE</Text><Title level={3}>{room?`房间 · ${room}`:'我的剪贴板'}</Title><Text type="secondary">文本与文件会实时同步到此房间的所有设备</Text></div><Tooltip title="切换房间"><Button shape="circle" icon={<DesktopOutlined/>} onClick={()=>{setRoomDraft(room);setRoomModal(true)}}/></Tooltip></div>
      <div className="message-list" onDragOver={onDrag} onDrop={onDrop}>
        {!items.length ? <div className="empty-state"><Welcome variant="borderless" icon={<div className="welcome-icon"><ThunderboltOutlined/></div>} title="把灵感放在这里" description="发送一段文字，或把文件拖进来，在你的设备间即时同步。"/></div> : <div className="timeline">{items.slice().reverse().map(item=><article className="message-row" key={item.id}><div className="avatar">{item.type==='file'?<PaperClipOutlined/>:<BulbOutlined/>}</div><div className="message-main"><div className="message-author"><Text strong>{item.type==='file'?'文件分享':'剪贴板内容'}</Text><Text type="secondary">{item.uploadTime?dayjs(item.uploadTime*1000).format('HH:mm'):''}</Text><Dropdown trigger={['click']} menu={{items:actions.map(a=>({key:a.key,label:a.label,icon:a.icon,danger:a.danger,onClick:()=>a.onClick(item)}))}}><Button type="text" size="small" icon={<SettingOutlined/>}/></Dropdown></div><div className="bubble-wrap">{content(item)}</div></div></article>)}<div ref={bottomRef}/></div>}
      </div>
      <section className="composer-shell"><div className="composer-hint"><span><i/> {status==='online'?'已连接 · 消息即时同步':'正在重新连接'}</span><span>当前房间：{room||'默认'}</span></div><div className="composer" onDragOver={onDrag} onDrop={onDrop}><Sender value={draft} onChange={setDraft} onSubmit={sendText} loading={busy&&!progress} disabled={status!=='online'||busy} placeholder="输入要同步的文本…（Enter 发送，Shift + Enter 换行）" autoSize={{minRows:2,maxRows:8}} onPaste={onPaste} footer={({components})=><div className="sender-footer"><Space><input ref={fileRef} type="file" multiple hidden onChange={e=>uploadFiles(e.target.files)}/><Tooltip title="添加文件（支持拖放与粘贴）"><Button type="text" icon={<PaperClipOutlined/>} onClick={()=>fileRef.current?.click()} disabled={busy}/></Tooltip><Text type="secondary">单文件最大 10 GiB · 文本不设长度上限</Text></Space><Space>{resumeInfo&&<Text type="secondary">{resumeInfo}</Text>}{progress>0&&<Progress type="circle" percent={progress} size={24}/>}<Button type="primary" shape="circle" icon={<SendOutlined/>} onClick={()=>sendText(draft)} disabled={!draft.trim()||status!=='online'||busy} aria-label="发送"/></Space></div>}/></div><div className="drop-caption"><CloudUploadOutlined/> 拖放文件到此处，或直接粘贴截图 / 文件</div></section>
    </main>
    <Modal title={preview?.name || '文件预览'} open={!!preview} onCancel={()=>setPreview(null)} footer={null} width={900}>
      {preview && (()=>{ const ext=preview.name.split('.').pop().toLowerCase(); const url=ext==='zip'||ext==='cbz'?`/preview/archive/${preview.cache}/${encodeURIComponent(preview.name)}`:['doc','docx','odt','rtf','ppt','pptx','odp'].includes(ext)?`/preview/document/${preview.cache}/${encodeURIComponent(preview.name)}`:`/preview/image/${preview.cache}/${encodeURIComponent(preview.name)}`; if(['mp4','webm','ogv','mov','m4v','mp3','wav','ogg','m4a'].includes(ext)) return <video src={`/file/${preview.cache}/${encodeURIComponent(preview.name)}`} controls preload="metadata" style={{width:'100%',maxHeight:'75vh'}}/>; if(['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return <img src={url} alt={preview.name} style={{maxWidth:'100%',maxHeight:'75vh',display:'block',margin:'auto'}}/>; if(['zip','cbz'].includes(ext)) return <div style={{maxHeight:'65vh',overflow:'auto'}}>{archiveEntries===null?'正在读取压缩包内容…':archiveEntries.length===0?<Empty description="压缩包为空"/>:<ul>{archiveEntries.map((entry,index)=><li key={`${entry.name}-${index}`}>{entry.directory?'📁':'📄'} {entry.name} · {formatSize(entry.size)}</li>)}</ul>}</div>; if(['doc','docx','odt','rtf','ppt','pptx','odp','pdf'].includes(ext)) return <iframe title="PDF preview" src={ext==='pdf'?`/file/${preview.cache}/${encodeURIComponent(preview.name)}`:url} style={{width:'100%',height:'75vh',border:0}}/>; return <Empty description="该文件类型暂不支持预览"/>; })()}
    </Modal>
    <Modal title="切换共享房间" open={roomModal} onOk={joinRoom} onCancel={()=>setRoomModal(false)} okText="进入房间" cancelText="取消"><Input value={roomDraft} onChange={e=>setRoomDraft(e.target.value)} placeholder="留空使用默认房间" onPressEnter={joinRoom}/><Text type="secondary" className="modal-help">房间名用于隔离不同设备间的消息。</Text></Modal>
  </div>;
}
