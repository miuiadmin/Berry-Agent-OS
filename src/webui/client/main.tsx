/**
 * SPA 入口（vite 入口——产物由 index.html 引入）。StrictMode 开发期双挂载
 * effect 会开两条 EventSource——App 侧 cleanup 关停，生产单连接。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('SPA 挂载点缺失（#root）');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
