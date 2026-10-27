import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import ClipboardApp from './App.jsx';
import './styles.css';

function Root() {
  const [dark, setDark] = React.useState(localStorage.getItem('clipboard-theme') === 'dark');
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: '#1677ff', borderRadius: 14, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }}>
    <AntApp><ClipboardApp dark={dark} onToggleTheme={() => setDark(v => { localStorage.setItem('clipboard-theme', v ? 'light' : 'dark'); return !v; })} /></AntApp>
  </ConfigProvider>;
}

createRoot(document.getElementById('root')).render(<Root />);
