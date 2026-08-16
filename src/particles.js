// src/particles.js

class Particle {
    constructor(x, y, char, atomicNum, color) {
        this.x = x;
        this.y = y;
        this.z = Math.random() * 2 - 1; // 3D depth (-1 to 1)
        
        // Base dimensions
        this.baseSize = 12; 
        this.size = this.baseSize;
        this.char = char;
        this.atomicNum = atomicNum;
        this.color = color;
        
        // Initial momentum biases upwards
        this.velocity = {
            x: (Math.random() - 0.5) * 0.5,
            y: Math.random() * -1 - 0.5, 
            z: (Math.random() - 0.5) * 0.05
        };
        this.target = { x: 0, y: 0, z: 0 };
        this.boxSize = this.size * 2.8; 
        this.radius = this.boxSize / 2; // For smooth collision physics
    }

    updateMobile(bounds) {
        // Minimal logic for mobile without heavy physics
        this.y -= 0.15; 
        if (this.y < -50) {
            this.y = bounds.height + 50;
            this.x = Math.random() * bounds.width;
        }
    }

    updateFlow(particles, index, mouse, gravityIntensity, bounds) {
        // Natural upward drift (Anti-Gravity effect)
        this.velocity.y += gravityIntensity;
        
        // Elegantly sway left/right
        this.velocity.x += Math.sin(Date.now() * 0.001 + this.atomicNum) * 0.015;

        // Soft Damping
        this.velocity.x *= 0.96;
        this.velocity.y *= 0.98;
        this.velocity.z *= 0.98;

        // Speed Limits for elegance 
        if (this.velocity.x > 1.5) this.velocity.x = 1.5;
        if (this.velocity.x < -1.5) this.velocity.x = -1.5;
        if (this.velocity.y < -2.5) this.velocity.y = -2.5;
        
        // Gently bounce depth (Z)
        if (this.z > 1) { this.z = 1; this.velocity.z *= -1; }
        if (this.z < -1) { this.z = -1; this.velocity.z *= -1; }

        this.x += this.velocity.x;
        this.y += this.velocity.y;
        this.z += this.velocity.z;

        // Screen wrap perfectly coordinated with bounds
        if (this.y < -50) {
            this.y = bounds.height + 50;
            this.x = Math.random() * bounds.width;
            this.velocity.y = Math.random() * -1 - 0.5;
        }
        if (this.x < -50) this.x = bounds.width + 50;
        if (this.x > bounds.width + 50) this.x = -50;

        // Apply mouse interaction but no heavy N-squared collision logic to keep performance overhead minimal
        this.applyMouse(mouse);
    }

    updateSphere(mouse) {
        // Smooth and fluid Lerp integration for the globe morphing
        this.x += (this.target.x - this.x) * 0.06;
        this.y += (this.target.y - this.y) * 0.06;
        this.z += (this.target.z - this.z) * 0.06;

        this.applyMouse(mouse);
    }

    applyMouse(mouse) {
        if (mouse.x !== null && mouse.y !== null) {
            let dx = this.x - mouse.x;
            let dy = this.y - mouse.y;
            let distSq = dx * dx + dy * dy;
            let mouseRadius = 200; // Large, smooth interaction field
            
            if (distSq < mouseRadius * mouseRadius) {
                let distance = Math.sqrt(distSq) || 1;
                let forceDirectionX = dx / distance;
                let forceDirectionY = dy / distance;
                let force = (mouseRadius - distance) / mouseRadius; 
                
                // Repel softly
                this.velocity.x += forceDirectionX * force * 0.5;
                this.velocity.y += forceDirectionY * force * 0.5;
                
                // Active displacement
                this.x += forceDirectionX * force * 2;
                this.y += forceDirectionY * force * 2;
            }
        }
    }

    draw(ctx, isLowPerformance, isMobile) {
        // High-end Perspective Scaling
        const perspective = 500;
        const scale = perspective / (perspective - (this.z * 180)); 
        
        // Depth-based transparency mapping for UI compliance, much fainter on mobile
        let alpha = Math.max(0.05, Math.min(0.5, (this.z + 1.8) / 3)); 
        if (isMobile) alpha *= 0.3; // Faint on mobile

        ctx.globalAlpha = alpha; 
        
        const currentBoxSize = this.boxSize * scale; 
        const halfBox = currentBoxSize / 2;
        const cornerRadius = 8 * scale; // Smooth rounded tiles

        ctx.strokeStyle = this.color;
        
        // Completely disable Expensive Glow Effects for PC performance optimizations
        ctx.shadowBlur = 0;

        ctx.fillStyle = this.color; 
        ctx.lineWidth = 1.5 * scale;

        // Path logic for High-End Rounded Rectangles
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(this.x - halfBox, this.y - halfBox, currentBoxSize, currentBoxSize, cornerRadius);
        } else {
            // Fallback for older browsers
            ctx.rect(this.x - halfBox, this.y - halfBox, currentBoxSize, currentBoxSize);
        }

        // Draw Translucent Glass Backdrop
        ctx.globalAlpha = alpha * 0.08; 
        ctx.fill();

        // Outline Core 
        ctx.globalAlpha = alpha * 0.8;
        ctx.stroke();

        ctx.shadowBlur = 0; // Disable glow for crisp text rendering

        // Typography Setups
        ctx.fillStyle = this.color;

        // Atomic Number Design
        ctx.globalAlpha = alpha * 0.9;
        ctx.font = `600 ${Math.max(5, currentBoxSize * 0.22)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.atomicNum, this.x - halfBox + 5 * scale, this.y - halfBox + 4 * scale);

        // Core Element Symbol Design
        ctx.globalAlpha = alpha;
        ctx.font = `800 ${Math.max(12, currentBoxSize * 0.45)}px 'Plus Jakarta Sans', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.char, this.x, this.y + currentBoxSize * 0.08);

        ctx.globalAlpha = 1; // Unify scope
    }
}

export function initParticles() {
    const canvas = document.createElement('canvas');
    canvas.id = 'antigravity-bg';
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.zIndex = '-1'; 
    canvas.style.pointerEvents = 'none'; 
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let particles = [];
    
    // Curated dynamic theme palettes
    const darkColors = ['#00FF41', '#22d3ee', '#818cf8', '#a78bfa'];
    const lightColors = ['#4338ca', '#0891b2', '#64748b', '#0f172a'];
    
    // Ordered Periodic elements mapping exactly to 118 items
    const chars = ['H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar','K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr','Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe','Cs','Ba','La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn','Fr','Ra','Ac','Th','Pa','U','Np','Pu','Am','Cm','Bk','Cf','Es','Fm','Md','No','Lr','Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og'];
    
    // Smart Device Category Detection
    function getDeviceTier() {
        const width = window.innerWidth;
        const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        const isIPadOS = (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || /iPad/i.test(navigator.userAgent);
        
        if (width < 640 || (/iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent) && !isIPadOS)) {
            return 'mobile';
        }
        if (isIPadOS || (isTouch && width <= 1024)) {
            return 'tablet';
        }
        return 'desktop';
    }

    let deviceTier = getDeviceTier();
    let isMobile = deviceTier === 'mobile';
    let isTablet = deviceTier === 'tablet';
    let isDesktop = deviceTier === 'desktop';
    let isLowPerformance = isMobile || isTablet;

    // Desktop/Laptop: Full 118 periodic elements!
    // Tablets/iPad: 25 elements (prevents WebKit memory crash)
    // Smartphones: 14 elements (battery/RAM friendly)
    let particleCount = isDesktop ? chars.length : (isTablet ? 25 : 14);

    let state = 'table'; 
    let morphInterval = 20000;
    let lastMorphTime = Date.now();

    // Periodic table structure map
    function getElementPos(atomicNum) {
        if (atomicNum === 1) return {r:0, c:0};
        if (atomicNum === 2) return {r:0, c:17};
        if (atomicNum >= 3 && atomicNum <= 4) return {r:1, c:atomicNum-3};
        if (atomicNum >= 5 && atomicNum <= 10) return {r:1, c:atomicNum-5+12};
        if (atomicNum >= 11 && atomicNum <= 12) return {r:2, c:atomicNum-11};
        if (atomicNum >= 13 && atomicNum <= 18) return {r:2, c:atomicNum-13+12};
        if (atomicNum >= 19 && atomicNum <= 36) return {r:3, c:atomicNum-19};
        if (atomicNum >= 37 && atomicNum <= 54) return {r:4, c:atomicNum-37};
        if (atomicNum >= 55 && atomicNum <= 57) return {r:5, c:atomicNum-55}; 
        if (atomicNum >= 72 && atomicNum <= 86) return {r:5, c:atomicNum-72+3};
        if (atomicNum >= 87 && atomicNum <= 89) return {r:6, c:atomicNum-87}; 
        if (atomicNum >= 104 && atomicNum <= 118) return {r:6, c:atomicNum-104+3};
        // Lanthanides (58-71)
        if (atomicNum >= 58 && atomicNum <= 71) return {r:8, c:atomicNum-58+3};
        // Actinides (90-103)
        if (atomicNum >= 90 && atomicNum <= 103) return {r:9, c:atomicNum-90+3};
        return {r:0, c:0};
    }

    let mouse = { x: null, y: null };
    let logicalBounds = { width: 0, height: 0 };

    window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
    });
    window.addEventListener('mouseout', () => {
        mouse.x = null;
        mouse.y = null;
    });

    // Touch support for smart boards & touchscreens
    window.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
            mouse.x = e.touches[0].clientX;
            mouse.y = e.touches[0].clientY;
        }
    }, { passive: true });

    window.addEventListener('touchend', () => {
        mouse.x = null;
        mouse.y = null;
    }, { passive: true });

    function resize() {
        deviceTier = getDeviceTier();
        isMobile = deviceTier === 'mobile';
        isTablet = deviceTier === 'tablet';
        isDesktop = deviceTier === 'desktop';
        isLowPerformance = isMobile || isTablet;

        // Desktop/Laptop: high crisp DPR up to 1.5.
        // Tablets/iPad/Smartphones: 1.0 (eliminates canvas memory bloat).
        // Smart Board / 4K (>1920px): cap at 1.25 for top performance.
        let maxDpr = 1.0;
        if (isDesktop) {
            maxDpr = window.innerWidth > 1920 ? 1.25 : 1.5;
        }
        
        const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
        
        logicalBounds.width = window.innerWidth;
        logicalBounds.height = window.innerHeight;
        
        canvas.width = Math.floor(logicalBounds.width * dpr);
        canvas.height = Math.floor(logicalBounds.height * dpr);
        
        canvas.style.width = logicalBounds.width + 'px';
        canvas.style.height = logicalBounds.height + 'px';
        
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function init() {
        particles = [];
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        const activeColors = isDarkTheme ? darkColors : lightColors;

        particleCount = isDesktop ? chars.length : (isTablet ? 25 : 14);

        for (let i = 0; i < particleCount; i++) {
            const x = Math.random() * logicalBounds.width;
            const y = Math.random() * logicalBounds.height;
            const char = chars[i % chars.length];
            const atomicNum = (i % chars.length) + 1; 
            const color = activeColors[i % activeColors.length];
            
            particles.push(new Particle(x, y, char, atomicNum, color));
        }
    }

    window.addEventListener('theme-change', init);
    
    window.addEventListener('resize', () => {
        const prevTier = deviceTier;
        resize();
        if (prevTier !== deviceTier) {
            init();
        }
    });

    function calculateTableTargets() {
        const cols = 18;
        const rows = 10;
        
        const cellWidth = Math.min(logicalBounds.width / (cols + 4), 60); 
        const cellHeight = cellWidth;
        
        const tableWidth = cols * cellWidth;
        const tableHeight = rows * cellHeight;
        
        const startX = (logicalBounds.width - tableWidth) / 2 + cellWidth / 2;
        const startY = (logicalBounds.height - tableHeight) / 2 + cellHeight / 2;

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const pos = getElementPos(p.atomicNum);
            
            p.target.x = startX + pos.c * cellWidth;
            p.target.y = startY + pos.r * cellHeight;
            p.target.z = 0;
        }
    }

    let isAnimationRunning = true;
    let animFrameId = null;

    function animate() {
        if (!isAnimationRunning) return;

        ctx.clearRect(0, 0, logicalBounds.width, logicalBounds.height);

        if (isDesktop) {
            // Full Laptop / PC Periodic Table & Flow Experience
            const now = Date.now();
            if (now - lastMorphTime > morphInterval) {
                state = state === 'flow' ? 'table' : 'flow';
                lastMorphTime = now;
                morphInterval = state === 'flow' ? 8000 : 25000; 
                
                if (state === 'flow') {
                    particles.forEach(p => {
                        let dx = p.x - logicalBounds.width / 2;
                        p.velocity.x = (dx > 0 ? 1 : -1) * (Math.random() * 0.5);
                        p.velocity.y = Math.random() * -1;
                        p.velocity.z = (Math.random() - 0.5);
                    });
                }
            }

            if (state === 'table') {
                calculateTableTargets();
                particles.forEach(p => p.updateSphere(mouse));
            } else {
                particles.forEach((p, index) => p.updateFlow(particles, index, mouse, -0.015, logicalBounds));
            }
        } else if (isTablet) {
            // Tablet / iPad: Smooth, lightweight flow with gentle mouse/touch interactions
            particles.forEach((p, index) => {
                p.y -= 0.4;
                p.x += Math.sin(Date.now() * 0.001 + p.atomicNum) * 0.2;
                if (p.y < -50) {
                    p.y = logicalBounds.height + 50;
                    p.x = Math.random() * logicalBounds.width;
                }
                p.applyMouse(mouse);
            });
        } else {
            // Mobile: Ultra-lightweight drift
            particles.forEach(p => {
                p.y -= 0.3;
                if (p.y < -50) p.y = logicalBounds.height + 50;
            });
        }

        // Draw particles
        const sortedParticles = isDesktop ? [...particles].sort((a, b) => a.z - b.z) : particles;
        sortedParticles.forEach(p => p.draw(ctx, isLowPerformance, isMobile));

        animFrameId = requestAnimationFrame(animate);
    }

    // Lifecycle: Pause rendering when tab is hidden (saves battery, prevents Safari background termination)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            isAnimationRunning = false;
            if (animFrameId) cancelAnimationFrame(animFrameId);
        } else {
            if (!isAnimationRunning) {
                isAnimationRunning = true;
                lastMorphTime = Date.now();
                animate();
            }
        }
    });

    window.addEventListener('pageshow', () => {
        if (!isAnimationRunning) {
            isAnimationRunning = true;
            animate();
        }
    });

    window.addEventListener('pagehide', () => {
        isAnimationRunning = false;
        if (animFrameId) cancelAnimationFrame(animFrameId);
    });

    resize();
    init();
    animate();
}
