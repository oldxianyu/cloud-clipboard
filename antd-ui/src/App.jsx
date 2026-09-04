import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntApp,
  Badge,
  Button,
  ConfigProvider,
  Empty,
  Input,
  Layout,
  Modal,
  Progress,
  Space,
  Tag,
  Typography,
  Upload,
  theme,
} from 'antd'
import {
  ClearOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  EyeOutlined,
  LinkOutlined,
  MobileOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'

const { Header, Content } = Layout
const { Text, Title } = Typography
const { TextArea } = Input

const AUTH_KEY = 'auth'
const ROOM_KEY = 'room'

function decodeHtml(s = '') {
  return String(s)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
}

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

function readRoom() {
  const params = new URLSearchParams(window.location.search)
  return params.get('room') || localStorage.getItem(ROOM_KEY) || ''
}

function authHeaders(auth) {
  return auth ? { Authorization: `Bearer ${auth}` } : {}
}

function contentUrl(item) {
  if (item?.share) return `${window.location.origin}/s/${item.share}`
  // fallback for very old items before share tokens existed
  return `${window.location.origin}/content/${item?.id}?room=`
}

function fileUrl(item) {
  return `${window.location.origin}/file/${item.cache}/${encodeURIComponent(item.name)}`
}

function previewUrl(item) {
  return `${window.location.origin}/preview/${item.cache}/${encodeURIComponent(item.name)}`
}

function isImageName(name = '') {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
}

function isVideoName(name = '') {
  return /\.(mp4|webm|ogv|mov|m4v)$/i.test(name)
}

function isAudioName(name = '') {
  return /\.(mp3|wav|ogg|opus|m4a|flac)$/i.test(name)
}

function isPdfName(name = '') {
  return /\.pdf$/i.test(name)
}

function isArchiveName(name = '') {
  return /\.(zip|rar|7z)$/i.test(name)
}

function archiveUrl(item) {
  return `${window.location.origin}/archive/${item.cache}`
}

function canPreview(item) {
  const name = item?.name || ''
  return (
    isImageName(name) ||
    isVideoName(name) ||
    isAudioName(name) ||
    isPdfName(name) ||
    isArchiveName(name) ||
    !!item?.thumbnail
  )
}

function formatEntrySize(n) {
  if (n == null || Number.isNaN(n)) return '-'
  return formatBytes(n)
}

async function downloadFile(item, message) {
  const url = fileUrl(item)
  const name = item?.name || 'download'
  try {
    // Prefer direct anchor download (same-origin). Backend also sets Content-Disposition: attachment.
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    // Fallback: fetch as blob then save
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`下载失败 ${res.status}`)
      const blob = await res.blob()
      const obj = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = obj
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(obj)
    } catch (e) {
      message?.error?.(e.message || String(e))
    }
  }
}

function AppInner() {
  const { message, modal } = AntApp.useApp()
  const [auth, setAuth] = useState(() => localStorage.getItem(AUTH_KEY) || '')
  const [authInput, setAuthInput] = useState(() => localStorage.getItem(AUTH_KEY) || '')
  const [authOpen, setAuthOpen] = useState(false)
  const [room, setRoom] = useState(readRoom)
  const [roomInput, setRoomInput] = useState(readRoom)
  const [roomOpen, setRoomOpen] = useState(false)
  const [text, setText] = useState('')
  const [items, setItems] = useState([])
  const [devices, setDevices] = useState([])
  const [config, setConfig] = useState({ text: { limit: 0 }, file: { limit: 0, expire: 0 } })
  const [status, setStatus] = useState('connecting')
  const [needAuth, setNeedAuth] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPercent, setUploadPercent] = useState(0)
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewItem, setPreviewItem] = useState(null)
  const [archiveInfo, setArchiveInfo] = useState(null)
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState('')

  const wsRef = useRef(null)
  const retryRef = useRef(0)
  const connIdRef = useRef(0)
  const activeUploadsRef = useRef(0)
  const uploadProgressRef = useRef(new Map())
  const roomRef = useRef(room)
  const authRef = useRef(auth)
  const messageRef = useRef(message)

  useEffect(() => {
    roomRef.current = room
  }, [room])
  useEffect(() => {
    authRef.current = auth
  }, [auth])
  useEffect(() => {
    messageRef.current = message
  }, [message])

  const textLimit = config?.text?.limit || 0
  const fileLimit = config?.file?.limit || 0
  // Always include room= so server history filter works for default room "".
  const roomQuery = useMemo(() => `?room=${encodeURIComponent(room || '')}`, [room])

  const disconnect = useCallback((clearList = false) => {
    connIdRef.current += 1
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onmessage = null
      wsRef.current.onerror = null
      try {
        wsRef.current.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
    setDevices([])
    if (clearList) setItems([])
  }, [])

  const connect = useCallback(async ({ silent = false } = {}) => {
    const myConn = ++connIdRef.current
    setStatus('connecting')

    if (wsRef.current) {
      wsRef.current.onclose = null
      try {
        wsRef.current.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }

    try {
      const res = await fetch('/server')
      if (!res.ok) throw new Error(`server ${res.status}`)
      const info = await res.json()
      if (myConn !== connIdRef.current) return

      setNeedAuth(!!info.auth)
      const currentAuth = authRef.current
      if (info.auth && !currentAuth) {
        setAuthOpen(true)
        setStatus('auth')
        return
      }

      const wsUrl = new URL(info.server, window.location.href)
      wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl.host = window.location.host
      if (info.auth && currentAuth) wsUrl.searchParams.set('auth', currentAuth)
      // Always set room (even empty). Missing room makes server return empty history.
      wsUrl.searchParams.set('room', roomRef.current || '')

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (myConn !== connIdRef.current) return
        setStatus('online')
        retryRef.current = 0
        setDevices([])
        if (!silent) messageRef.current.success('已连接服务器')
      }

      ws.onmessage = (ev) => {
        if (myConn !== connIdRef.current) return
        try {
          const parsed = JSON.parse(ev.data)
          const { event, data } = parsed
          if (event === 'config') setConfig(data)
          else if (event === 'receiveMulti') setItems(Array.from(data || []).reverse())
          else if (event === 'receive') setItems((prev) => [data, ...prev.filter((x) => x.id !== data.id)])
          else if (event === 'revoke') setItems((prev) => prev.filter((x) => x.id !== data.id))
          else if (event === 'connect') {
            setDevices((prev) => (prev.some((d) => d.id === data.id) ? prev : [...prev, data]))
          } else if (event === 'disconnect') {
            setDevices((prev) => prev.filter((d) => d.id !== data.id))
          } else if (event === 'forbidden') {
            localStorage.removeItem(AUTH_KEY)
            setAuth('')
            setAuthInput('')
            setAuthOpen(true)
            setStatus('auth')
            setItems([])
            messageRef.current.error('密码错误，请重新输入')
          }
        } catch {
          /* ignore */
        }
      }

      ws.onerror = () => {}
      ws.onclose = () => {
        if (myConn !== connIdRef.current) return
        setStatus('offline')
        setDevices([])
        if (retryRef.current < 3) {
          retryRef.current += 1
          setTimeout(() => {
            if (myConn === connIdRef.current) connect({ silent: true })
          }, 1200)
        } else {
          messageRef.current.error('连接服务器失败，请点击重连')
        }
      }

      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('')
      }, 30000)
      ws.addEventListener('close', () => clearInterval(heartbeat))
    } catch (err) {
      if (myConn !== connIdRef.current) return
      setStatus('offline')
      if (retryRef.current < 3) {
        retryRef.current += 1
        setTimeout(() => {
          if (myConn === connIdRef.current) connect({ silent: true })
        }, 1200)
      } else {
        messageRef.current.error(`连接失败：${err.message || err}`)
      }
    }
  }, [])

  useEffect(() => {
    retryRef.current = 0
    connect({ silent: true })
    return () => disconnect(false)
  }, [connect, disconnect, room, auth])

  const sendText = async () => {
    const body = text.trimEnd()
    if (!body) return message.warning('请输入文本')
    if (textLimit && body.length > textLimit) return message.error(`文本不能超过 ${textLimit} 字`)
    setSending(true)
    try {
      const res = await fetch(`/text${roomQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...authHeaders(auth) },
        body,
      })
      if (res.status === 403) {
        setAuthOpen(true)
        throw new Error('需要密码或密码错误')
      }
      const data = await res.json()
      if (!res.ok || data.code !== 200) throw new Error(data.msg || `发送失败 ${res.status}`)
      setText('')
      message.success('已发送')
    } catch (err) {
      message.error(err.message || String(err))
    } finally {
      setSending(false)
    }
  }

  const uploadFile = async (file) => {
    if (fileLimit && file.size > fileLimit) {
      message.error(`文件不能超过 ${formatBytes(fileLimit)}`)
      return false
    }
    activeUploadsRef.current += 1
    setUploading(true)
    const uploadId = `${Date.now()}-${Math.random()}`
    uploadProgressRef.current.set(uploadId, { loaded: 0, total: file.size })
    const updateProgress = () => {
      const all = [...uploadProgressRef.current.values()]
      const loaded = all.reduce((sum, item) => sum + item.loaded, 0)
      const total = all.reduce((sum, item) => sum + item.total, 0)
      setUploadPercent(total ? Math.round((loaded / total) * 100) : 0)
    }
    const headers = authHeaders(auth)
    const request = async (url, options = {}) => {
      const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } })
      const data = await res.json().catch(() => ({}))
      if (res.status === 403) {
        setAuthOpen(true)
        throw new Error('需要密码或密码错误')
      }
      if (!res.ok || (data.code !== undefined && data.code !== 200)) {
        throw new Error(data.msg || `上传失败 ${res.status}`)
      }
      return data
    }
    try {
      const fileSha256 = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const sha256 = [...new Uint8Array(fileSha256)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const initResponse = await request(`/upload/chunk${roomQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ name: file.name, size: file.size, sha256 }),
      })
      const init = initResponse.result || initResponse
      const chunkSize = 1024 * 1024
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
        const chunkBuffer = await chunk.arrayBuffer()
        const chunkDigest = await crypto.subtle.digest('SHA-256', chunkBuffer)
        const chunkSha256 = [...new Uint8Array(chunkDigest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        await request(`/upload/chunk/${init.uuid}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Offset': String(offset),
            'X-Chunk-SHA256': chunkSha256,
          },
          body: chunkBuffer,
        })
        uploadProgressRef.current.set(uploadId, { loaded: Math.min(offset + chunk.size, file.size), total: file.size })
        updateProgress()
      }
      const doneResponse = await request(`/upload/finish/${init.uuid}${roomQuery}`, { method: 'POST' })
      const done = doneResponse.result || doneResponse
      if (done.url) message.success(`已上传 ${file.name}`)
    } catch (err) {
      message.error(`${file.name}：${err.message || '上传失败'}`)
    } finally {
      uploadProgressRef.current.delete(uploadId)
      activeUploadsRef.current -= 1
      setUploading(activeUploadsRef.current > 0)
      updateProgress()
      if (activeUploadsRef.current === 0) setUploadPercent(0)
    }
    return false
  }

  const revokeOne = async (id) => {
    try {
      const res = await fetch(`/revoke/${id}${roomQuery}`, {
        method: 'DELETE',
        headers: authHeaders(auth),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.code !== 200) throw new Error(data.msg || `删除失败 ${res.status}`)
      message.success('已删除')
    } catch (err) {
      message.error(err.message || String(err))
    }
  }

  const revokeAll = () => {
    modal.confirm({
      title: '清空当前房间历史？',
      content: '此操作会删除当前房间内的全部消息。',
      okText: '清空',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const res = await fetch(`/revoke/all${roomQuery}`, {
          method: 'DELETE',
          headers: authHeaders(auth),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.code !== 200) throw new Error(data.msg || `清空失败 ${res.status}`)
        message.success('已清空')
      },
    })
  }

  const copyText = async (value) => {
    try {
      await navigator.clipboard.writeText(value)
      message.success('已复制')
    } catch (err) {
      message.error(`复制失败：${err}`)
    }
  }

  const openPreview = async (item) => {
    setPreviewItem(item)
    setPreviewOpen(true)
    setArchiveInfo(null)
    setArchiveError('')
    if (isArchiveName(item?.name || '')) {
      setArchiveLoading(true)
      try {
        const res = await fetch(archiveUrl(item))
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.code !== 200) {
          throw new Error(data.msg || `预览失败 ${res.status}`)
        }
        setArchiveInfo(data.result || data)
      } catch (err) {
        setArchiveError(err.message || String(err))
      } finally {
        setArchiveLoading(false)
      }
    }
  }

  const statusTag = {
    connecting: <Tag color="processing">连接中</Tag>,
    online: <Tag color="success">在线</Tag>,
    offline: <Tag color="error">离线</Tag>,
    auth: <Tag color="warning">待认证</Tag>,
  }[status]

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand">
          <div className="brand-mark" />
          <Title level={4} className="brand-title">
            云剪贴板
          </Title>
          {statusTag}
          <span className="hide-mobile">{room ? <Tag color="blue">房间 {room}</Tag> : <Tag>默认房间</Tag>}</span>
        </div>
        <div className="header-actions">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              retryRef.current = 0
              connect({ silent: false })
            }}
          >
            <span className="hide-mobile">重连</span>
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setRoomOpen(true)}>
            <span className="hide-mobile">房间</span>
          </Button>
          {needAuth && (
            <Button
              onClick={() => {
                setAuthInput(auth)
                setAuthOpen(true)
              }}
            >
              密码
            </Button>
          )}
        </div>
      </Header>

      <Content
        className={`workspace ${dragOver ? 'drop-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const files = [...(e.dataTransfer.files || [])]
          files.forEach(uploadFile)
        }}
        onPaste={(e) => {
          const pasteItems = e.clipboardData?.items || []
          for (const it of pasteItems) {
            if (it.kind === 'file') {
              const f = it.getAsFile()
              if (f) {
                uploadFile(f)
                e.preventDefault()
                return
              }
            }
          }
        }}
      >
        <section className="panel panel-send">
          <div className="panel-hd">
            <div>
              <h3>发送</h3>
              <div className="panel-sub">文本 / 文件 / 拖拽 / 粘贴截图</div>
            </div>
            <div className="meta-row">
              <Tag>文本 {textLimit ? `${textLimit}` : '-'}</Tag>
              <Tag>文件 {fileLimit ? formatBytes(fileLimit) : '-'}</Tag>
            </div>
          </div>

          <div className="panel-bd">
            <div className="composer-area">
              <TextArea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="输入文本，或选择上传文件/截图"
                maxLength={textLimit || undefined}
                showCount={!!textLimit}
                autoSize={{ minRows: 6, maxRows: 12 }}
                onPressEnter={(e) => {
                  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
                    e.preventDefault()
                    sendText()
                  }
                }}
              />
              <div className="composer-actions">
                <div className="left-actions">
                  <Upload beforeUpload={uploadFile} multiple showUploadList={false} accept="*/*">
                    <Button icon={<CloudUploadOutlined />} loading={uploading} block>
                      上传文件
                    </Button>
                  </Upload>
                </div>
                <Text type="secondary" className="hide-mobile">
                  Ctrl/Cmd + Enter 发送
                </Text>
                <Button
                  className="send-btn"
                  type="primary"
                  size="large"
                  icon={<SendOutlined />}
                  loading={sending}
                  onClick={sendText}
                  block
                >
                  发送
                </Button>
              </div>
              {uploading && <Progress percent={uploadPercent} size="small" />}
            </div>
          </div>

        </section>

        <section className="panel panel-history">
          <div className="panel-hd">
            <div>
              <h3>历史记录</h3>
              <div className="panel-sub">刷新后保留 · 实时同步</div>
            </div>
            <Space>
              <Badge count={items.length} overflowCount={999} color="#1677ff" />
              <Button danger icon={<ClearOutlined />} onClick={revokeAll} disabled={!items.length}>
                清空
              </Button>
            </Space>
          </div>

          <div className="history-list">
            {items.length === 0 ? (
              <div className="empty-wrap">
                <Empty description={status === 'online' ? '还没有内容' : '正在连接并加载历史…'} />
              </div>
            ) : (
              items.map((item) => {
                const isText = item.type === 'text'
                const plain = isText ? decodeHtml(item.content || '') : ''
                return (
                  <article className="clip-item" key={item.id}>
                    <div className="clip-top">
                      <div className="clip-meta">
                        <Tag color={isText ? 'blue' : 'purple'}>{isText ? '文本' : '文件'}</Tag>
                        <span className="hide-mobile">#{item.id}</span>
                        {item.expire && item.expire < 4102444800 ? <span>过期 {dayjs.unix(item.expire).format('MM-DD HH:mm')}</span> : (item.type==='file' ? <span>不过期</span> : null)}
                        {!isText && <span>{formatBytes(item.size)}</span>}
                      </div>
                      <div className="clip-actions">
                        {isText ? (
                          <Button size="small" icon={<CopyOutlined />} onClick={() => copyText(plain)}>
                            复制
                          </Button>
                        ) : (
                          <>
                            {canPreview(item) && (
                              <Button size="small" icon={<EyeOutlined />} onClick={() => openPreview(item)}>
                                预览
                              </Button>
                            )}
                            <Button
                              size="small"
                              type="primary"
                              onClick={() => downloadFile(item, message)}
                            >
                              下载
                            </Button>
                          </>
                        )}
                        <Button size="small" icon={<LinkOutlined />} onClick={() => copyText(contentUrl(item))}>
                          链接
                        </Button>
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => revokeOne(item.id)}>
                          删除
                        </Button>
                      </div>
                    </div>
                    <div className="clip-body">
                      {isText ? (
                        <pre className="item-text">{plain}</pre>
                      ) : (
                        <>
                          <Text strong>{item.name}</Text>
                          {item.thumbnail ? (
                            <img
                              className="thumb thumb-clickable"
                              src={item.thumbnail}
                              alt={item.name}
                              onClick={() => openPreview(item)}
                            />
                          ) : null}
                        </>
                      )}
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </section>
        <section className="panel panel-devices">
          <div className="device-strip">
            <div className="device-strip-title">
              <span>在线设备</span>
              <Badge count={devices.length} showZero color="#1677ff" />
            </div>
            {devices.length === 0 ? (
              <Text type="secondary">暂无其他设备</Text>
            ) : (
              <div className="device-row">
                {devices.map((d) => (
                  <div className="device-chip" key={d.id}>
                    {d.type === 'mobile' ? <MobileOutlined /> : <DesktopOutlined />}
                    <span>{d.device || d.browser || '设备'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </Content>

      <Modal
        title="输入访问密码"
        open={authOpen}
        okText="连接"
        cancelText="取消"
        centered
        destroyOnHidden
        onOk={() => {
          const v = authInput.trim()
          if (!v) return message.warning('请输入密码')
          localStorage.setItem(AUTH_KEY, v)
          setAuth(v)
          setAuthOpen(false)
          retryRef.current = 0
        }}
        onCancel={() => setAuthOpen(false)}
      >
        <Input.Password
          value={authInput}
          onChange={(e) => setAuthInput(e.target.value)}
          placeholder="访问密码"
          onPressEnter={() => {
            const v = authInput.trim()
            if (!v) return
            localStorage.setItem(AUTH_KEY, v)
            setAuth(v)
            setAuthOpen(false)
            retryRef.current = 0
          }}
        />
      </Modal>

      <Modal
        title="房间"
        open={roomOpen}
        okText="进入"
        cancelText="取消"
        centered
        onOk={() => {
          const v = roomInput.trim()
          localStorage.setItem(ROOM_KEY, v)
          setRoom(v)
          const url = new URL(window.location.href)
          if (v) url.searchParams.set('room', v)
          else url.searchParams.delete('room')
          window.history.replaceState({}, '', url)
          setRoomOpen(false)
          retryRef.current = 0
          setItems([])
        }}
        onCancel={() => setRoomOpen(false)}
      >
        <Input
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value)}
          placeholder="留空为默认房间"
          addonAfter={
            <Button
              type="link"
              size="small"
              onClick={() => {
                const names = ['alpha', 'beta', 'delta', 'omega', 'nova', 'pixel', 'orbit', 'quark']
                const name = names[Math.floor(Math.random() * names.length)]
                setRoomInput(`${name}-${Math.random().toString(16).slice(2, 6)}`)
              }}
            >
              随机
            </Button>
          }
        />
      </Modal>

      <Modal
        title={previewItem?.name || '预览'}
        open={previewOpen}
        onCancel={() => {
          setPreviewOpen(false)
          setPreviewItem(null)
          setArchiveInfo(null)
          setArchiveError('')
          setArchiveLoading(false)
        }}
        footer={[
          <Button key="close" onClick={() => {
            setPreviewOpen(false)
            setPreviewItem(null)
            setArchiveInfo(null)
            setArchiveError('')
            setArchiveLoading(false)
          }}>
            关闭
          </Button>,
          previewItem ? (
            <Button key="dl" type="primary" onClick={() => downloadFile(previewItem, message)}>
              下载
            </Button>
          ) : null,
        ]}
        centered
        width="min(960px, 96vw)"
        destroyOnHidden
        className="preview-modal"
      >
        {previewItem ? (
          <div className="preview-body">
            {isImageName(previewItem.name) ? (
              <img className="preview-media" src={previewUrl(previewItem)} alt={previewItem.name} />
            ) : isVideoName(previewItem.name) ? (
              <video className="preview-media" src={previewUrl(previewItem)} controls autoPlay playsInline />
            ) : isAudioName(previewItem.name) ? (
              <audio className="preview-audio" src={previewUrl(previewItem)} controls autoPlay />
            ) : isPdfName(previewItem.name) ? (
              <iframe className="preview-frame" title={previewItem.name} src={previewUrl(previewItem)} />
            ) : isArchiveName(previewItem.name) ? (
              <div className="archive-preview">
                {archiveLoading ? (
                  <div className="archive-status">正在读取压缩包目录…</div>
                ) : archiveError ? (
                  <Empty description={archiveError} />
                ) : archiveInfo ? (
                  <>
                    <div className="archive-meta">
                      <Tag color="purple">{(archiveInfo.format || 'archive').toUpperCase()}</Tag>
                      <span>共 {archiveInfo.count ?? archiveInfo.entries?.length ?? 0} 项</span>
                      {archiveInfo.truncated ? <Tag color="orange">仅显示前 2000 项</Tag> : null}
                    </div>
                    <div className="archive-list">
                      {(archiveInfo.entries || []).map((entry, idx) => (
                        <div className="archive-row" key={`${entry.name}-${idx}`}>
                          <div className="archive-name" title={entry.name}>
                            {entry.isDir ? '📁' : '📄'} {entry.name}
                          </div>
                          <div className="archive-size">
                            {entry.isDir ? '-' : formatEntrySize(entry.size)}
                          </div>
                        </div>
                      ))}
                      {(archiveInfo.entries || []).length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="压缩包为空" />
                      ) : null}
                    </div>
                  </>
                ) : (
                  <Empty description="暂无压缩包信息" />
                )}
              </div>
            ) : previewItem.thumbnail ? (
              <img className="preview-media" src={previewItem.thumbnail} alt={previewItem.name} />
            ) : (
              <Empty description="该文件类型暂不支持预览，请直接下载" />
            )}
          </div>
        ) : null}
      </Modal>
    </Layout>
  )
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 10,
          colorBgLayout: '#f5f5f5',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
      }}
    >
      <AntApp>
        <AppInner />
      </AntApp>
    </ConfigProvider>
  )
}
