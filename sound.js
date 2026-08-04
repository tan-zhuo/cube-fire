// sound.js — Web Audio 合成音效，无外部资源，离线可用
// 所有音色由振荡器 + 噪声实时合成；首次用户交互时初始化 AudioContext
(function () {
'use strict';

class SoundFX {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.enabled = true;
        this._noiseBuffer = null;
    }

    ensure() {
        try {
            if (!this.ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return false;
                this.ctx = new AC();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.35;
                this.master.connect(this.ctx.destination);
            }
            if (this.ctx.state === 'suspended') this.ctx.resume();
            return true;
        } catch (e) {
            return false;
        }
    }

    toggle() {
        this.enabled = !this.enabled;
        return this.enabled;
    }

    // ---------- 基础合成单元 ----------
    _now() { return this.ctx.currentTime; }

    // 振荡器扫频音
    tone(type, f0, f1, dur, vol = 0.5, delay = 0) {
        if (!this.enabled || !this.ensure()) return;
        try {
            const t = this._now() + delay;
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(Math.max(1, f0), t);
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            osc.connect(g);
            g.connect(this.master);
            osc.start(t);
            osc.stop(t + dur + 0.02);
        } catch (e) {}
    }

    // 噪声爆发（带滤波扫频）
    noise(dur, fStart, fEnd, vol = 0.5, delay = 0, type = 'lowpass') {
        if (!this.enabled || !this.ensure()) return;
        try {
            const t = this._now() + delay;
            if (!this._noiseBuffer) {
                const len = this.ctx.sampleRate * 0.5;
                this._noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
                const data = this._noiseBuffer.getChannelData(0);
                for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
            }
            const src = this.ctx.createBufferSource();
            src.buffer = this._noiseBuffer;
            const filter = this.ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.setValueAtTime(Math.max(10, fStart), t);
            filter.frequency.exponentialRampToValueAtTime(Math.max(10, fEnd), t + dur);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            src.connect(filter);
            filter.connect(g);
            g.connect(this.master);
            src.start(t);
            src.stop(t + dur + 0.02);
        } catch (e) {}
    }

    // ---------- 游戏音效 ----------
    shoot(vol = 1) {
        this.noise(0.09, 3200, 400, 0.42 * vol);
        this.tone('square', 620, 160, 0.08, 0.16 * vol);
    }

    hitConfirm() { // 命中反馈（打中别人）
        this.tone('sine', 1300, 900, 0.05, 0.32);
        this.noise(0.03, 5000, 2500, 0.15, 0, 'highpass');
    }

    hurt() { // 自己被击中
        this.noise(0.14, 700, 120, 0.5);
        this.tone('sine', 180, 70, 0.16, 0.4);
    }

    kill() { // 击杀奖励音
        this.tone('triangle', 520, 780, 0.09, 0.4);
        this.tone('triangle', 780, 1180, 0.12, 0.36, 0.08);
        this.noise(0.16, 4000, 900, 0.14, 0.05, 'highpass');
    }

    death() { // 自己阵亡
        this.tone('sawtooth', 220, 45, 0.55, 0.34);
        this.noise(0.4, 900, 90, 0.3);
    }

    melee(vol = 1) { // 挥刀
        this.noise(0.14, 400, 3800, 0.35 * vol, 0, 'bandpass');
    }

    wallHit(vol = 1) {
        this.noise(0.04, 1800, 300, 0.24 * vol);
    }

    pickup() {
        this.tone('triangle', 660, 660, 0.07, 0.3);
        this.tone('triangle', 880, 880, 0.07, 0.3, 0.07);
        this.tone('triangle', 1320, 1320, 0.1, 0.3, 0.14);
    }

    respawn() {
        this.tone('sine', 330, 660, 0.2, 0.3);
    }

    gameStart() {
        this.tone('triangle', 440, 440, 0.12, 0.4);
        this.tone('triangle', 660, 660, 0.2, 0.4, 0.14);
    }

    gameEnd() {
        this.tone('triangle', 520, 520, 0.25, 0.35);
        this.tone('triangle', 390, 390, 0.32, 0.35, 0.2);
    }

    countdownTick() {
        this.tone('sine', 880, 880, 0.06, 0.25);
    }
}

window.gameSound = new SoundFX();

// 浏览器要求用户交互后才能启动音频
const boot = () => { window.gameSound.ensure(); };
document.addEventListener('pointerdown', boot);
document.addEventListener('keydown', (e) => {
    boot();
    // M 键静音/取消静音
    if ((e.key === 'm' || e.key === 'M') && !e.target.matches('input, textarea')) {
        window.gameSound.toggle();
    }
});
})();
