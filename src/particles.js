// src/particles.js - Refined, Spaced-Out Periodic Table with Proximity Glow & Subtle Sway
// Elements are compact, elegant, and spaced out ("ටිකක් ඈතින් ඈත ලස්සනටම").
// Auto-pauses at 0% CPU when settled.

class PeriodicElement {
    constructor(baseX, baseY, char, atomicNum, color, size) {
        this.baseX = baseX;
        this.baseY = baseY;
        this.x = baseX;
        this.y = baseY;
        this.vx = 0;
        this.vy = 0;
        this.char = char;
        this.atomicNum = atomicNum;
        this.color = color;
        this.boxSize = size;
        this.hoverFactor = 0; // 0 = resting faint, 1 = highlighted near cursor
    }

    update(mouse, maxDistance = 130) {
        let targetHover = 0;

        if (mouse.x !== null && mouse.y !== null) {
            const dx = this.baseX - mouse.x;
            const dy = this.baseY - mouse.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < maxDistance * maxDistance && distSq > 0) {
                const dist = Math.sqrt(distSq);
                const force = (1 - dist / maxDistance);
                targetHover = force;

                // Delicate subtle sway (max 5-7px displacement)
                const pushX = (dx / dist) * force * 0.9;
                const pushY = (dy / dist) * force * 0.9;
                this.vx += pushX;
                this.vy += pushY;
            }
        }

        // Smoothly interpolate hover highlight
        this.hoverFactor += (targetHover - this.hoverFactor) * 0.18;

        // Spring physics returning to base position
        const ax = (this.baseX - this.x) * 0.16;
        const ay = (this.baseY - this.y) * 0.16;
        this.vx = (this.vx + ax) * 0.72;
        this.vy = (this.vy + ay) * 0.72;

        this.x += this.vx;
        this.y += this.vy;

        // Check if settled to rest
        const isSettled = Math.abs(this.vx) < 0.015 && 
                          Math.abs(this.vy) < 0.015 && 
                          Math.abs(this.x - this.baseX) < 0.04 && 
                          Math.abs(this.y - this.baseY) < 0.04 &&
                          this.hoverFactor < 0.01;

        if (isSettled) {
            this.x = this.baseX;
            this.y = this.baseY;
            this.vx = 0;
            this.vy = 0;
            this.hoverFactor = 0;
            return false;
        }

        return true;
    }

    draw(ctx, isMobile) {
        // Faint and classy base alpha, brightly illuminates on mouse proximity
        const baseAlpha = isMobile ? 0.07 : 0.14;
        const alpha = baseAlpha + (this.hoverFactor * 0.65);

        const halfBox = this.boxSize / 2;
        const cornerRadius = 5;

        ctx.lineWidth = this.hoverFactor > 0.1 ? 1.4 : 0.9;
        ctx.strokeStyle = this.color;
        ctx.fillStyle = this.color;
        ctx.shadowBlur = 0;

        // Draw tile box
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(this.x - halfBox, this.y - halfBox, this.boxSize, this.boxSize, cornerRadius);
        } else {
            ctx.rect(this.x - halfBox, this.y - halfBox, this.boxSize, this.boxSize);
        }

        // Translucent background
        ctx.globalAlpha = Math.min(1, alpha * 0.16);
        ctx.fill();

        // Outline
        ctx.globalAlpha = Math.min(1, alpha * 0.85);
        ctx.stroke();

        // Atomic Number
        ctx.globalAlpha = Math.min(1, alpha * 0.88);
        ctx.font = `600 ${Math.max(5, this.boxSize * 0.22)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.atomicNum, this.x - halfBox + 3, this.y - halfBox + 2.5);

        // Element Symbol
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.font = `700 ${Math.max(9, this.boxSize * 0.44)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.char, this.x, this.y + this.boxSize * 0.07);

        ctx.globalAlpha = 1;
    }
}

export function initParticles() {
    let canvas = document.getElementById('antigravity-bg');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'antigravity-bg';
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.zIndex = '-1';
        canvas.style.pointerEvents = 'none';
        document.body.prepend(canvas);
    }

    const ctx = canvas.getContext('2d', { alpha: true });
    let elements = [];

    const darkPalette = ['#00FF41', '#22d3ee', '#818cf8', '#38bdf8', '#34d399', '#a78bfa'];
    const lightPalette = ['#0284c7', '#0891b2', '#4f46e5', '#059669', '#6366f1', '#475569'];

    const chars = ['H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar','K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr','Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe','Cs','Ba','La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn','Fr','Ra','Ac','Th','Pa','U','Np','Pu','Am','Cm','Bk','Cf','Es','Fm','Md','No','Lr','Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og'];

    function getElementPos(atomicNum) {
        if (atomicNum === 1) return { r: 0, c: 0 };
        if (atomicNum === 2) return { r: 0, c: 17 };
        if (atomicNum >= 3 && atomicNum <= 4) return { r: 1, c: atomicNum - 3 };
        if (atomicNum >= 5 && atomicNum <= 10) return { r: 1, c: atomicNum - 5 + 12 };
        if (atomicNum >= 11 && atomicNum <= 12) return { r: 2, c: atomicNum - 11 };
        if (atomicNum >= 13 && atomicNum <= 18) return { r: 2, c: atomicNum - 13 + 12 };
        if (atomicNum >= 19 && atomicNum <= 36) return { r: 3, c: atomicNum - 19 };
        if (atomicNum >= 37 && atomicNum <= 54) return { r: 4, c: atomicNum - 37 };
        if (atomicNum >= 55 && atomicNum <= 57) return { r: 5, c: atomicNum - 55 };
        if (atomicNum >= 72 && atomicNum <= 86) return { r: 5, c: atomicNum - 72 + 3 };
        if (atomicNum >= 87 && atomicNum <= 89) return { r: 6, c: atomicNum - 87 };
        if (atomicNum >= 104 && atomicNum <= 118) return { r: 6, c: atomicNum - 104 + 3 };
        // Lanthanides (58-71)
        if (atomicNum >= 58 && atomicNum <= 71) return { r: 7.7, c: atomicNum - 58 + 3 };
        // Actinides (90-103)
        if (atomicNum >= 90 && atomicNum <= 103) return { r: 8.8, c: atomicNum - 90 + 3 };
        return { r: 0, c: 0 };
    }

    let isMobile = window.innerWidth < 768;
    let mouse = { x: null, y: null };
    let logicalWidth = window.innerWidth;
    let logicalHeight = window.innerHeight;
    let isLoopRunning = false;
    let animFrameId = null;

    function resize() {
        isMobile = window.innerWidth < 768;
        const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.0 : 1.25);
        logicalWidth = window.innerWidth;
        logicalHeight = window.innerHeight;

        canvas.width = Math.floor(logicalWidth * dpr);
        canvas.height = Math.floor(logicalHeight * dpr);
        canvas.style.width = logicalWidth + 'px';
        canvas.style.height = logicalHeight + 'px';

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function initGrid() {
        elements = [];
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        const palette = isDarkTheme ? darkPalette : lightPalette;

        const cols = 18;
        const rows = 10;

        // Generous spacing across the screen: cells are wide, boxes are compact!
        const cellWidth = isMobile 
            ? Math.max(20, (logicalWidth * 0.96) / (cols + 0.5)) 
            : Math.min(68, Math.max(48, (logicalWidth * 0.92) / cols));
        const cellHeight = cellWidth * 1.05;

        const tableWidth = cols * cellWidth;
        const tableHeight = rows * cellHeight;
        const startX = (logicalWidth - tableWidth) / 2 + cellWidth / 2;
        const startY = (logicalHeight - tableHeight) / 2 + cellHeight / 2;

        // Compact, elegant box size leaving ample breathing room ("ඈතින් ඈත ලස්සනට")
        const boxSize = isMobile 
            ? Math.min(20, cellWidth * 0.72) 
            : Math.min(30, cellWidth * 0.54);

        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const atomicNum = i + 1;
            const pos = getElementPos(atomicNum);
            const x = startX + pos.c * cellWidth;
            const y = startY + pos.r * cellHeight;
            const color = palette[i % palette.length];

            elements.push(new PeriodicElement(x, y, char, atomicNum, color, boxSize));
        }

        renderOnce();
    }

    function renderOnce() {
        ctx.clearRect(0, 0, logicalWidth, logicalHeight);
        for (let i = 0; i < elements.length; i++) {
            elements[i].draw(ctx, isMobile);
        }
    }

    function loop() {
        ctx.clearRect(0, 0, logicalWidth, logicalHeight);

        let anyMoving = false;
        const maxDistance = isMobile ? 80 : 130;

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            const isMoving = el.update(mouse, maxDistance);
            if (isMoving) anyMoving = true;
            el.draw(ctx, isMobile);
        }

        if (anyMoving) {
            animFrameId = requestAnimationFrame(loop);
        } else {
            // Settled to resting state (0% CPU)
            isLoopRunning = false;
            animFrameId = null;
        }
    }

    function wakeUp() {
        if (!isLoopRunning) {
            isLoopRunning = true;
            animFrameId = requestAnimationFrame(loop);
        }
    }

    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        wakeUp();
    }, { passive: true });

    window.addEventListener('mouseleave', () => {
        mouse.x = null;
        mouse.y = null;
        wakeUp();
    });

    window.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
            mouse.x = e.touches[0].clientX;
            mouse.y = e.touches[0].clientY;
            wakeUp();
        }
    }, { passive: true });

    window.addEventListener('touchend', () => {
        mouse.x = null;
        mouse.y = null;
        wakeUp();
    }, { passive: true });

    window.addEventListener('resize', () => {
        resize();
        initGrid();
    });

    window.addEventListener('theme-change', () => {
        initGrid();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (animFrameId) cancelAnimationFrame(animFrameId);
            isLoopRunning = false;
        } else {
            renderOnce();
        }
    });

    resize();
    initGrid();
}
