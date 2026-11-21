import { SPEC_VERSION } from '@edithtml/core';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) app.textContent = `EditHTML — spec v${SPEC_VERSION}（Web 应用见任务 T4.1）`;
