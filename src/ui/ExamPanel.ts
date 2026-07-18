/**
 * ui/ExamPanel.ts — 受験UI（M4課目単体＋M5試験モード通し・スコア履歴・最小HUD切替）。
 *
 * - 課目受験（練習・単体）／試験（3課目通し）の開始・中止ボタン
 * - 持ち点表示・字幕（試験員指示）・警告フラッシュ・減点トースト
 * - 課目レポート（合否・減点内訳・上面図軌跡。シリーズ中は「次の課目へ」ボタン付き）
 * - 総合レポート（3課目通しの課目別成績と最終合否）
 * - スコア履歴（localStorage・ScoreHistoryはmain側が保持し、hooks経由で読む）
 * - 最小HUD切替（試験モードで指示と時間のみの表示にする。適用はmain側）
 */

import type { Course } from '../exam/Course';
import type { ExamResult } from '../exam/ExamSession';
import type { ExamSeriesResult } from '../exam/ExamSeries';
import type { ScoreEntry } from '../exam/ScoreHistory';
import type { DeductionEvent } from '../exam/ScoringEngine';
import { computeCourseBBox } from '../render/CourseMarkers';
import { H_PAD_RADIUS } from '../exam/geometry';

export interface ExamPanelHooks {
  onStartPractice: () => void;
  onStartSeries: () => void;
  onAbort: () => void;
  getHistory: () => ScoreEntry[];
  onClearHistory: () => void;
  onMinimalHud: (v: boolean) => void;
}

/**
 * レポート表示のオプション。主ボタン（次の課目へ／総合成績を見る）と閉じるボタンの
 * ラベル・動作を明示注入する（呼び出し側＝mainがモード遷移の正を持つ）。
 */
export interface ReportOptions {
  primaryLabel?: string;
  onPrimary?: () => void;
  closeLabel?: string;
  onClose?: () => void;
}

const TOAST_LIFETIME_MS = 6000;

export class ExamPanel {
  private readonly hooks: ExamPanelHooks;
  private readonly panel: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly seriesBtn: HTMLButtonElement;
  private readonly scoreEl: HTMLSpanElement;
  private readonly statusEl: HTMLDivElement;
  private readonly minHudChk: HTMLInputElement;
  private readonly continueChk: HTMLInputElement;
  private readonly historyList: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly warnEl: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private running = false;
  private warnTimer: number | null = null;

  constructor(app: HTMLElement, panelParent: HTMLElement, hooks: ExamPanelHooks) {
    this.hooks = hooks;
    this.panel = document.createElement('div');
    this.panel.id = 'exam-panel';
    this.panel.innerHTML = `
      <div class="ep-title">受験</div>
      <div class="ep-row">
        <button type="button" id="ep-start">課目受験</button>
        <button type="button" id="ep-series">試験（3課目通し）</button>
      </div>
      <div class="ep-row"><span class="ep-score">持ち点 <span id="ep-points">–</span></span>
        <label class="pp-inline"><input type="checkbox" id="ep-minhud"> 最小HUD（H）</label></div>
      <div class="ep-row"><label class="pp-inline"><input type="checkbox" id="ep-continue"> 通し試験: 不合格でも続行（練習）</label></div>
      <div class="ep-status" id="ep-status">課目受験=現在の課目を単体練習／試験=4-1→4-2→4-3通し（持ち点100共通）</div>
      <details id="ep-history"><summary>スコア履歴</summary>
        <div id="ep-history-list"></div>
        <button type="button" id="ep-history-clear">履歴を消去</button>
      </details>
      <div class="ep-note">Space=安全確認の宣言（実試験の「安全確認よし」の代替）。実試験の「監視不足」「操縦装置の両手保持」は自動判定不能のため採点対象外</div>
    `;
    panelParent.appendChild(this.panel);
    this.startBtn = this.panel.querySelector('#ep-start')!;
    this.seriesBtn = this.panel.querySelector('#ep-series')!;
    this.scoreEl = this.panel.querySelector('#ep-points')!;
    this.statusEl = this.panel.querySelector('#ep-status')!;
    this.minHudChk = this.panel.querySelector('#ep-minhud')!;
    this.continueChk = this.panel.querySelector('#ep-continue')!;
    this.historyList = this.panel.querySelector('#ep-history-list')!;
    this.startBtn.addEventListener('click', () => {
      if (this.running) hooks.onAbort();
      else hooks.onStartPractice();
    });
    this.seriesBtn.addEventListener('click', () => hooks.onStartSeries());
    this.minHudChk.addEventListener('change', () => hooks.onMinimalHud(this.minHudChk.checked));
    this.panel
      .querySelector<HTMLDetailsElement>('#ep-history')!
      .addEventListener('toggle', (e) => {
        if ((e.target as HTMLDetailsElement).open) this.refreshHistory();
      });
    this.panel.querySelector('#ep-history-clear')!.addEventListener('click', () => {
      hooks.onClearHistory();
      this.refreshHistory();
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

  setRunning(label: string): void {
    this.running = true;
    this.startBtn.textContent = '中止';
    this.seriesBtn.disabled = true;
    this.continueChk.disabled = true;
    this.statusEl.textContent = `${label} 受験中`;
    this.toasts.replaceChildren();
    this.subtitle.hidden = true;
    this.overlay.hidden = true;
  }

  setIdle(): void {
    this.running = false;
    this.startBtn.textContent = '課目受験';
    this.seriesBtn.disabled = false;
    this.continueChk.disabled = false;
    this.statusEl.textContent =
      '課目受験=現在の課目を単体練習／試験=4-1→4-2→4-3通し（持ち点100共通）';
    this.subtitle.hidden = true;
    this.warnEl.hidden = true;
  }

  /** 通し試験の「不合格でも続行（練習）」設定（startSeries時にmainが読む） */
  getContinueOnFail(): boolean {
    return this.continueChk.checked;
  }

  setScore(points: number): void {
    this.scoreEl.textContent = String(points);
  }

  setMinimalHudChecked(v: boolean): void {
    this.minHudChk.checked = v;
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

  hideReport(): void {
    this.overlay.hidden = true;
  }

  /**
   * 課目レポート（減点内訳の時系列＋上面図の軌跡）。opts.onPrimary があれば主ボタン
   * （「次の課目へ」＝continueSeries、または「総合成績を見る」＝series要約表示）を出す。
   */
  showReport(result: ExamResult, course: Course, opts?: ReportOptions): void {
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
    const primaryBtn = opts?.onPrimary
      ? `<button type="button" id="rp-continue">${escapeHtml(opts.primaryLabel ?? '次へ')}</button>`
      : '';
    this.overlay.innerHTML = `
      <div class="report-dialog">
        <div class="rp-head">${escapeHtml(result.courseName)} — ${verdict}
          <span class="rp-points">持ち点 ${result.points} 点</span></div>
        <div class="rp-meta">所要 ${result.elapsedS.toFixed(0)}秒 / 制限 ${result.timeLimitS}秒
          ｜方向: ${result.direction === 'standard' ? '基準' : '逆'}｜${endReasonLabel(result)}</div>
        <canvas id="rp-canvas" width="560" height="330"></canvas>
        <div class="rp-tablewrap">
          <table class="rp-table">
            <thead><tr><th>時刻</th><th>コード</th><th>点</th><th>理由</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4">減点なし</td></tr>'}</tbody>
          </table>
        </div>
        ${primaryBtn}
        <button type="button" id="rp-close">${escapeHtml(opts?.closeLabel ?? '閉じる')}</button>
      </div>`;
    this.overlay.hidden = false;
    this.overlay.querySelector('#rp-close')!.addEventListener('click', () => {
      this.overlay.hidden = true;
      opts?.onClose?.();
    });
    if (opts?.onPrimary) {
      this.overlay.querySelector('#rp-continue')!.addEventListener('click', () => {
        this.overlay.hidden = true;
        opts.onPrimary!();
      });
    }
    this.drawTopView(result, course);
  }

  /** 総合レポート（試験モード3課目通し） */
  showSeriesReport(sr: ExamSeriesResult, courses: readonly Course[]): void {
    const rows = sr.results
      .map((r, i) => {
        const c = courses[i];
        const verdict = r.passed
          ? '<span class="rp-pass">通過</span>'
          : `<span class="rp-fail">${endReasonLabel(r)}</span>`;
        return `<tr><td>${escapeHtml(c?.name ?? r.courseId)}</td><td>${r.points}点</td><td>${verdict}</td><td>${r.elapsedS.toFixed(0)}s / ${r.timeLimitS}s</td></tr>`;
      })
      .join('');
    const skipped = courses
      .slice(sr.results.length)
      .map((c) => `<tr><td>${escapeHtml(c.name)}</td><td colspan="3">未実施（試験終了）</td></tr>`)
      .join('');
    const verdict = sr.passed
      ? '<span class="rp-pass">合格</span>'
      : '<span class="rp-fail">不合格</span>';
    this.overlay.innerHTML = `
      <div class="report-dialog">
        <div class="rp-head">試験（3課目通し） — ${verdict}
          <span class="rp-points">最終 ${sr.points} 点</span></div>
        <div class="rp-meta">持ち点100点を3課目で共有。各課目終了時に70点以上で通過${
          sr.endedEarly ? '｜途中終了' : ''
        }</div>
        <div class="rp-tablewrap">
          <table class="rp-table">
            <thead><tr><th>課目</th><th>終了時点</th><th>結果</th><th>所要/制限</th></tr></thead>
            <tbody>${rows}${skipped}</tbody>
          </table>
        </div>
        <button type="button" id="rp-close">閉じる</button>
      </div>`;
    this.overlay.hidden = false;
    this.overlay.querySelector('#rp-close')!.addEventListener('click', () => {
      this.overlay.hidden = true;
    });
  }

  private refreshHistory(): void {
    const entries = this.hooks.getHistory();
    if (entries.length === 0) {
      this.historyList.innerHTML = '<div class="ep-history-empty">まだ記録がありません</div>';
      return;
    }
    this.historyList.innerHTML = entries
      .map((e) => {
        const date = e.at.slice(5, 16).replace('T', ' ');
        const verdict = e.passed
          ? '<span class="rp-pass">合格</span>'
          : '<span class="rp-fail">不合格</span>';
        return `<div class="ep-history-row">${date}｜${escapeHtml(e.label)}｜${e.points}点｜${verdict}</div>`;
      })
      .join('');
  }

  /** 上面図: コース経路＋H円＋飛行軌跡＋減点位置（コース座標そのまま・x右/z上=奥） */
  private drawTopView(result: ExamResult, course: Course): void {
    const canvas = this.overlay.querySelector<HTMLCanvasElement>('#rp-canvas')!;
    const ctx = canvas.getContext('2d')!;
    const bbox = computeCourseBBox(course.path, 4);
    const sx = canvas.width / (bbox.maxX - bbox.minX);
    const sy = canvas.height / (bbox.maxZ - bbox.minZ);
    const s = Math.min(sx, sy);
    const toX = (x: number): number => (x - (bbox.minX + bbox.maxX) / 2) * s + canvas.width / 2;
    const toY = (z: number): number => canvas.height / 2 - (z - (bbox.minZ + bbox.maxZ) / 2) * s;

    ctx.fillStyle = '#22222a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 経路
    ctx.strokeStyle = 'rgba(245, 242, 232, 0.75)';
    ctx.lineWidth = 1.5;
    const path = course.path;
    ctx.beginPath();
    if (path.kind === 'polygon') {
      path.points.forEach((p, i) =>
        i === 0 ? ctx.moveTo(toX(p.x), toY(p.z)) : ctx.lineTo(toX(p.x), toY(p.z)),
      );
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
