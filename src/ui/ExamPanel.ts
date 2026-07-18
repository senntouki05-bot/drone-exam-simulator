/**
 * ui/ExamPanel.ts — 受験UI（M4の最小実装・正式な練習/試験モードUIはM5）。
 *
 * - 課目開始/中止ボタン（開始クリックでAudio/TTSのアンロックはmain側フックが行う）
 * - 持ち点表示・字幕（試験員指示）・警告フラッシュ・減点トースト
 * - 終了レポート: 合否・減点内訳（時系列）・上面図の軌跡＋減点位置
 */

import type { Course } from '../exam/Course';
import type { ExamResult } from '../exam/ExamSession';
import type { DeductionEvent } from '../exam/ScoringEngine';
import { computeCourseBBox } from '../render/CourseMarkers';
import { H_PAD_RADIUS } from '../exam/geometry';

export interface ExamPanelHooks {
  onStart: () => void;
  onAbort: () => void;
}

const TOAST_LIFETIME_MS = 6000;

export class ExamPanel {
  private readonly panel: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly scoreEl: HTMLSpanElement;
  private readonly statusEl: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly warnEl: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private running = false;
  private warnTimer: number | null = null;

  constructor(app: HTMLElement, hooks: ExamPanelHooks) {
    this.panel = document.createElement('div');
    this.panel.id = 'exam-panel';
    this.panel.innerHTML = `
      <div class="ep-title">受験（課目単体）</div>
      <div class="ep-row"><button type="button" id="ep-start">課目開始</button>
        <span class="ep-score">持ち点 <span id="ep-points">–</span></span></div>
      <div class="ep-status" id="ep-status">開始すると試験員の指示が流れます（音声＋字幕）</div>
      <div class="ep-note">Space=安全確認の宣言（実試験の「安全確認よし」の代替）。実試験の「監視不足」「操縦装置の両手保持」は自動判定不能のため採点対象外</div>
    `;
    app.appendChild(this.panel);
    this.startBtn = this.panel.querySelector('#ep-start')!;
    this.scoreEl = this.panel.querySelector('#ep-points')!;
    this.statusEl = this.panel.querySelector('#ep-status')!;
    this.startBtn.addEventListener('click', () => {
      if (this.running) hooks.onAbort();
      else hooks.onStart();
    });

    this.subtitle = document.createElement('div');
    this.subtitle.id = 'exam-subtitle';
    this.subtitle.hidden = true;
    app.appendChild(this.subtitle);

    this.warnEl = document.createElement('div');
    this.warnEl.id = 'exam-warning';
    this.warnEl.hidden = true;
    app.appendChild(this.warnEl);

    this.toasts = document.createElement('div');
    this.toasts.id = 'exam-toasts';
    app.appendChild(this.toasts);

    this.overlay = document.createElement('div');
    this.overlay.id = 'report-overlay';
    this.overlay.hidden = true;
    app.appendChild(this.overlay);
  }

  setRunning(courseName: string): void {
    this.running = true;
    this.startBtn.textContent = '中止';
    this.statusEl.textContent = `${courseName} 受験中`;
    this.toasts.replaceChildren();
    this.subtitle.hidden = true;
    this.overlay.hidden = true;
  }

  setIdle(): void {
    this.running = false;
    this.startBtn.textContent = '課目開始';
    this.statusEl.textContent = '開始すると試験員の指示が流れます（音声＋字幕）';
    this.subtitle.hidden = true;
    this.warnEl.hidden = true;
  }

  setScore(points: number): void {
    this.scoreEl.textContent = String(points);
  }

  showInstruction(text: string): void {
    this.subtitle.textContent = `🗣 ${text}`;
    this.subtitle.hidden = false;
  }

  flashWarning(message: string): void {
    this.warnEl.textContent = `⚠ ${message}`;
    this.warnEl.hidden = false;
    if (this.warnTimer !== null) clearTimeout(this.warnTimer);
    this.warnTimer = window.setTimeout(() => {
      this.warnEl.hidden = true;
    }, 2200);
  }

  addToast(d: DeductionEvent): void {
    const el = document.createElement('div');
    el.className = d.immediate ? 'ep-toast ep-toast-fail' : 'ep-toast';
    el.textContent = d.immediate
      ? `✕ 即不合格 [${d.code}] ${d.reason}`
      : `−${d.points} [${d.code}] ${d.reason}`;
    this.toasts.appendChild(el);
    window.setTimeout(() => el.remove(), TOAST_LIFETIME_MS);
  }

  showReport(result: ExamResult, course: Course): void {
    const rows = result.deductions
      .map(
        (d) =>
          `<tr><td>${d.t.toFixed(1)}s</td><td>${d.code}</td><td>${
            d.immediate ? '即不合格' : `−${d.points}`
          }</td><td>${escapeHtml(d.reason)}</td></tr>`,
      )
      .join('');
    const verdict = result.passed
      ? '<span class="rp-pass">合格</span>'
      : '<span class="rp-fail">不合格</span>';
    this.overlay.innerHTML = `
      <div class="report-dialog">
        <div class="rp-head">${escapeHtml(result.courseName)} — ${verdict}
          <span class="rp-points">最終 ${result.points} 点</span></div>
        <div class="rp-meta">所要 ${result.elapsedS.toFixed(0)}秒 / 制限 ${result.timeLimitS}秒
          ｜方向: ${result.direction === 'standard' ? '基準' : '逆'}｜${endReasonLabel(result)}</div>
        <canvas id="rp-canvas" width="560" height="330"></canvas>
        <div class="rp-tablewrap">
          <table class="rp-table">
            <thead><tr><th>時刻</th><th>コード</th><th>点</th><th>理由</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4">減点なし</td></tr>'}</tbody>
          </table>
        </div>
        <button type="button" id="rp-close">閉じる</button>
      </div>`;
    this.overlay.hidden = false;
    this.overlay.querySelector('#rp-close')!.addEventListener('click', () => {
      this.overlay.hidden = true;
    });
    this.drawTopView(result, course);
  }

  /** 上面図: コース経路＋H円＋飛行軌跡＋減点位置（コース座標そのまま・x右/z上=奥） */
  private drawTopView(result: ExamResult, course: Course): void {
    const canvas = this.overlay.querySelector<HTMLCanvasElement>('#rp-canvas')!;
    const ctx = canvas.getContext('2d')!;
    const bbox = computeCourseBBox(course.path, 4);
    const sx = canvas.width / (bbox.maxX - bbox.minX);
    const sy = canvas.height / (bbox.maxZ - bbox.minZ);
    const s = Math.min(sx, sy);
    const toX = (x: number): number =>
      (x - (bbox.minX + bbox.maxX) / 2) * s + canvas.width / 2;
    const toY = (z: number): number =>
      canvas.height / 2 - (z - (bbox.minZ + bbox.maxZ) / 2) * s;

    ctx.fillStyle = '#22222a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 経路
    ctx.strokeStyle = 'rgba(245, 242, 232, 0.75)';
    ctx.lineWidth = 1.5;
    const path = course.path;
    ctx.beginPath();
    if (path.kind === 'polygon') {
      path.points.forEach((p, i) => (i === 0 ? ctx.moveTo(toX(p.x), toY(p.z)) : ctx.lineTo(toX(p.x), toY(p.z))));
      ctx.closePath();
    } else if (path.kind === 'circles') {
      for (const c of path.circles) {
        ctx.moveTo(toX(c.center.x + c.radiusM), toY(c.center.z));
        ctx.arc(toX(c.center.x), toY(c.center.z), c.radiusM * s, 0, Math.PI * 2);
      }
    } else {
      ctx.moveTo(toX(path.from.x), toY(path.from.z));
      ctx.lineTo(toX(path.to.x), toY(path.to.z));
    }
    ctx.stroke();

    // H円
    ctx.strokeStyle = 'rgba(245, 242, 232, 0.9)';
    ctx.beginPath();
    ctx.arc(toX(course.h.x), toY(course.h.z), H_PAD_RADIUS * s, 0, Math.PI * 2);
    ctx.stroke();

    // 軌跡
    if (result.track.length > 1) {
      ctx.strokeStyle = '#5da9ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      result.track.forEach((p, i) =>
        i === 0 ? ctx.moveTo(toX(p.x), toY(p.z)) : ctx.lineTo(toX(p.x), toY(p.z)),
      );
      ctx.stroke();
    }

    // 減点位置
    for (const d of result.deductions) {
      const x = toX(d.pos.x);
      const y = toY(d.pos.z);
      if (d.immediate) {
        ctx.strokeStyle = '#ff5a5a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 5);
        ctx.lineTo(x + 5, y + 5);
        ctx.moveTo(x + 5, y - 5);
        ctx.lineTo(x - 5, y + 5);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#ffc428';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function endReasonLabel(r: ExamResult): string {
  switch (r.endReason) {
    case 'completed':
      return '課目完了';
    case 'immediate_fail':
      return `即不合格（${r.failCode}）`;
    case 'points_exhausted':
      return '持ち点が合格ラインを下回り終了';
    case 'aborted':
      return '中止';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
