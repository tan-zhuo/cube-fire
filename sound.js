// sound.js — Web Audio 合成音效与背景音乐，无外部资源，离线可用
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
        if (window.gameMusic) window.gameMusic.setMuted(!this.enabled);
        const btn = document.getElementById('soundToggle');
        if (btn) {
            btn.textContent = (window.I18N ? I18N.t(this.enabled ? 'lp.soundOn' : 'lp.soundOff') : (this.enabled ? '声音 开' : '声音 关'));
            btn.classList.toggle('off', !this.enabled);
        }
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
    shoot(vol = 1, weapon = 'rifle') {
        switch (weapon) {
            case 'smg': // 轻快短促
                this.noise(0.06, 2800, 500, 0.30 * vol);
                this.tone('square', 700, 220, 0.05, 0.12 * vol);
                break;
            case 'shotgun': // 低沉轰响
                this.noise(0.22, 1400, 90, 0.55 * vol);
                this.tone('sawtooth', 200, 55, 0.18, 0.30 * vol);
                break;
            case 'sniper': // 尖锐炸裂 + 长尾
                this.noise(0.05, 6000, 2000, 0.5 * vol, 0, 'highpass');
                this.noise(0.35, 2200, 150, 0.4 * vol);
                this.tone('sawtooth', 900, 90, 0.22, 0.22 * vol);
                break;
            case 'rpg': // 火箭发射：低沉喷射轰鸣
                this.noise(0.30, 900, 120, 0.5 * vol);
                this.tone('sawtooth', 140, 60, 0.28, 0.30 * vol);
                this.noise(0.10, 3000, 800, 0.2 * vol, 0, 'highpass');
                break;
            case 'mech': // 机甲加特林：沉重速射炮点
                this.noise(0.05, 1600, 300, 0.34 * vol);
                this.tone('square', 220, 110, 0.05, 0.2 * vol);
                break;
            default: // 步枪
                this.noise(0.09, 3200, 400, 0.42 * vol);
                this.tone('square', 620, 160, 0.08, 0.16 * vol);
        }
    }

    reload() { // 换弹：退匣-上匣两段咔嗒
        this.tone('square', 240, 180, 0.04, 0.20);
        this.noise(0.03, 3000, 1500, 0.12, 0.02, 'highpass');
        this.tone('square', 300, 420, 0.05, 0.22, 0.16);
        this.noise(0.04, 3500, 1800, 0.15, 0.17, 'highpass');
    }

    emptyClick() { // 空仓击锤
        this.tone('square', 520, 380, 0.03, 0.16);
        this.noise(0.02, 4000, 2500, 0.08, 0, 'highpass');
    }

    heli() { // 直升机旋翼：低频节拍扫过（约3.5秒）
        for (let i = 0; i < 24; i++) {
            this.noise(0.05, 300, 90, 0.22, i * 0.145);
            if (i % 2 === 0) this.tone('sawtooth', 55, 55, 0.1, 0.1, i * 0.145);
        }
    }

    mechLand(vol = 1) { // 机甲落地：重锤砸地
        this.noise(0.3, 500, 60, 0.55 * vol);
        this.tone('sine', 70, 30, 0.35, 0.5 * vol);
        this.noise(0.12, 2500, 600, 0.2 * vol, 0.02);
    }

    crateBreak(vol = 1) { // 木箱碎裂：闷响 + 木屑脆声
        this.noise(0.12, 900, 150, 0.35 * vol);
        this.noise(0.08, 3200, 900, 0.2 * vol, 0.02, 'bandpass');
        this.tone('triangle', 160, 90, 0.1, 0.2 * vol);
    }

    streak(level = 2) { // 连杀号角：底鼓起势 + 级别越高音阶越长越亮
        this.tone('sine', 150, 45, 0.14, 0.5);
        this.noise(0.06, 2500, 600, 0.3);
        const base = [392, 494, 587, 740, 880, 1109]; // G4 B4 D5 F#5 A5 C#6
        const n = Math.min(base.length, 1 + level);
        for (let i = 0; i < n; i++) {
            this.tone('triangle', base[i], base[i], 0.15, 0.45, 0.06 + i * 0.08);
            this.tone('square', base[i] * 2, base[i] * 2, 0.1, 0.1, 0.06 + i * 0.08); // 高八度增亮
        }
        if (level >= 5) this.noise(0.4, 6000, 1200, 0.22, 0.06 + n * 0.08, 'highpass');
    }

    streakEnd() { // 连杀被终结：下行短叹
        this.tone('triangle', 660, 660, 0.1, 0.28);
        this.tone('triangle', 440, 440, 0.16, 0.26, 0.1);
    }

    grenadeThrow(vol = 1) { // 投掷：轻抛滑音 + 保险片脆响
        this.tone('sine', 300, 520, 0.12, 0.18 * vol);
        this.noise(0.03, 5000, 2500, 0.10 * vol, 0, 'highpass');
    }

    explosion(vol = 1) { // 爆炸：重低频轰 + 碎响长尾
        this.noise(0.5, 700, 50, 0.65 * vol);
        this.tone('sine', 90, 32, 0.42, 0.5 * vol);
        this.noise(0.28, 4500, 500, 0.22 * vol, 0.02, 'highpass');
    }

    hitConfirm() { // 命中反馈（打中别人）
        this.tone('sine', 1300, 900, 0.05, 0.32);
        this.noise(0.03, 5000, 2500, 0.15, 0, 'highpass');
    }

    hurt() { // 自己被击中
        this.noise(0.14, 700, 120, 0.5);
        this.tone('sine', 180, 70, 0.16, 0.4);
    }

    kill() { // 击杀确认：响亮双音上行 + 亮镲收尾
        this.tone('triangle', 520, 780, 0.1, 0.55);
        this.tone('triangle', 780, 1180, 0.14, 0.5, 0.08);
        this.tone('square', 1560, 1560, 0.08, 0.2, 0.17);
        this.noise(0.2, 6500, 2200, 0.24, 0.05, 'highpass');
    }

    death() { // 自己阵亡
        this.tone('sawtooth', 220, 45, 0.55, 0.34);
        this.noise(0.4, 900, 90, 0.3);
    }

    melee(vol = 1) { // 挥刀
        this.noise(0.14, 400, 3800, 0.35 * vol, 0, 'bandpass');
    }

    claw(vol = 1) { // 利爪撕裂：三连快挥 + 低吼
        this.noise(0.07, 900, 4200, 0.28 * vol, 0, 'bandpass');
        this.noise(0.07, 1100, 4800, 0.24 * vol, 0.05, 'bandpass');
        this.noise(0.09, 800, 3600, 0.26 * vol, 0.1, 'bandpass');
        this.tone('sawtooth', 95, 55, 0.22, 0.16 * vol);
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

// ---------- 背景音乐引擎 ----------
// 与音效共用 AudioContext，全部由振荡器实时合成，无外部音频文件。
// 两条曲目按 64 步（4 小节 × 16 分音符）循环调度：
//   menu   — 大厅氛围曲：慢速铺底和弦 + 轻柔琶音（Am7 F△7 C△7 G6）
//   battle — 战斗节奏曲：鼓组 + 锯齿低音 + 方波琶音（Am F C G）
class MusicEngine {
    constructor(sfx) {
        this.sfx = sfx;
        this.gain = null;
        this.track = null;   // 'menu' | 'battle' | null
        this.muted = false;
        this.step = 0;
        this.nextTime = 0;
        this.timer = null;
        this._nb = null;     // 噪声缓冲（鼓组用）
    }

    ensure() {
        if (!this.sfx.ensure()) return false;
        if (!this.gain) {
            this.gain = this.sfx.ctx.createGain();
            this.gain.gain.value = this.muted ? 0 : 0.55;
            this.gain.connect(this.sfx.master);
        }
        return true;
    }

    play(track) {
        if (!this.ensure()) return;
        if (this.track === track) return;
        this.track = track;
        this.step = 0;
        this.nextTime = this.sfx.ctx.currentTime + 0.08;
        if (!this.timer) this.timer = setInterval(() => this._tick(), 50);
    }

    stop() {
        this.track = null;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    setMuted(m) {
        this.muted = m;
        if (!this.gain) return;
        const t = this.sfx.ctx.currentTime;
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setTargetAtTime(m ? 0 : 0.55, t, 0.05);
    }

    _tick() {
        if (!this.track || this.muted || !this.sfx.ctx) return;
        const now = this.sfx.ctx.currentTime;
        // 后台标签页节流或静音恢复后追帧：跳到当前时间，避免积压的步一次性爆发
        if (this.nextTime < now - 0.05) this.nextTime = now + 0.05;
        const spb = 60 / (this.track === 'battle' ? 132 : 76) / 4; // 每 16 分音符的秒数
        while (this.nextTime < now + 0.25) {
            try {
                if (this.track === 'battle') this._battleStep(this.step, this.nextTime, spb);
                else this._menuStep(this.step, this.nextTime, spb);
            } catch (e) {}
            this.nextTime += spb;
            this.step = (this.step + 1) % 64;
        }
    }

    // ---------- 发声单元 ----------
    _f(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

    _note(type, midi, t, dur, vol, opts = {}) {
        const ctx = this.sfx.ctx;
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(this._f(midi), t);
        let node = osc;
        if (opts.cutoff) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(opts.cutoff, t);
            osc.connect(lp);
            node = lp;
        }
        const g = ctx.createGain();
        const atk = opts.attack || 0.006;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(vol, t + atk);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        node.connect(g);
        g.connect(this.gain);
        osc.start(t);
        osc.stop(t + dur + 0.03);
    }

    _noiseHit(t, dur, vol, freq, type = 'highpass') {
        const ctx = this.sfx.ctx;
        if (!this._nb) {
            const len = ctx.sampleRate * 0.5;
            this._nb = ctx.createBuffer(1, len, ctx.sampleRate);
            const d = this._nb.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        const src = ctx.createBufferSource();
        src.buffer = this._nb;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.setValueAtTime(freq, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(f);
        f.connect(g);
        g.connect(this.gain);
        src.start(t);
        src.stop(t + dur + 0.02);
    }

    _kick(t) {
        const ctx = this.sfx.ctx;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.42, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
        osc.connect(g);
        g.connect(this.gain);
        osc.start(t);
        osc.stop(t + 0.15);
    }

    _snare(t) {
        this._noiseHit(t, 0.10, 0.17, 1700, 'highpass');
        this._note('triangle', 53, t, 0.06, 0.10);
    }

    _hat(t, vol) {
        this._noiseHit(t, 0.035, vol, 7500, 'highpass');
    }

    // ---------- 曲目 ----------
    _battleStep(s, t, spb) {
        const bar = (s / 16) | 0;
        const p = s % 16;
        // 鼓组：四踩 + 2/4 拍军鼓 + 8 分踩镲
        if (p % 4 === 0) this._kick(t);
        if (p === 4 || p === 12) this._snare(t);
        if (p % 2 === 0) this._hat(t, p % 4 === 2 ? 0.15 : 0.08);
        if (bar === 3 && p === 15) this._hat(t, 0.14);
        // 低音：Am F C G，8 分音符驱动，句尾翻高八度
        const bass = [33, 29, 36, 31][bar];
        if (p % 2 === 0) {
            const up = (p === 6 || p === 14) ? 12 : 0;
            this._note('sawtooth', bass + up, t, spb * 1.8, 0.30, { cutoff: 420, attack: 0.004 });
        }
        // 琶音：和弦内音 16 分上行
        const chords = [[69, 72, 76, 81], [65, 69, 72, 77], [64, 67, 72, 76], [67, 71, 74, 79]];
        this._note('square', chords[bar][p % 4], t, spb * 1.1, 0.05, { cutoff: 2600 });
        // 每小节三角波铺底和声
        if (p === 0) {
            const pad = [[57, 64], [53, 60], [60, 67], [55, 62]][bar];
            for (const m of pad) this._note('triangle', m, t, spb * 15, 0.045, { attack: 0.3 });
        }
    }

    _menuStep(s, t, spb) {
        const bar = (s / 16) | 0;
        const p = s % 16;
        const chords = [
            [57, 60, 64, 67],  // Am7
            [53, 57, 60, 64],  // Fmaj7
            [48, 55, 59, 64],  // Cmaj7
            [50, 55, 59, 64],  // G6/D
        ];
        const tones = chords[bar];
        // 整小节铺底和弦 + 低音根音
        if (p === 0) {
            for (const m of tones) this._note('triangle', m, t, spb * 16, 0.075, { attack: 0.8 });
            this._note('sine', tones[0] - 12, t, spb * 14, 0.13, { attack: 0.15 });
        }
        // 轻柔正弦琶音（8 分音符）
        if (p % 2 === 0) {
            const order = [0, 1, 2, 3, 2, 1, 0, 2];
            this._note('sine', tones[order[(p / 2) | 0]] + 12, t, spb * 3, 0.05, { attack: 0.03 });
        }
        // 循环第四小节的高音点缀
        if (s === 56) this._note('sine', tones[3] + 24, t, spb * 6, 0.035, { attack: 0.05 });
    }
}

window.gameMusic = new MusicEngine(window.gameSound);

// 浏览器要求用户交互后才能启动音频；首次交互时顺带拉起背景音乐
const boot = () => {
    window.gameSound.ensure();
    if (!window.gameMusic.track && window.gameSound.enabled) {
        const login = document.getElementById('loginModal');
        const inGame = login && login.classList.contains('hidden');
        window.gameMusic.play(inGame ? 'battle' : 'menu');
    }
};
document.addEventListener('pointerdown', boot);
document.addEventListener('keydown', (e) => {
    boot();
    // M 键静音/取消静音（音效 + 音乐）
    if ((e.key === 'm' || e.key === 'M') && !e.target.matches('input, textarea')) {
        window.gameSound.toggle();
    }
});
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('soundToggle');
    if (btn) btn.addEventListener('click', () => window.gameSound.toggle());
});
})();
