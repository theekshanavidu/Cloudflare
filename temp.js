export async function renderOrganicGame() {
  const appContainer = document.getElementById('app-container');
  appContainer.innerHTML = `
    <div id="organic-game-root" style="width: 100%; height: 100%; min-height: calc(100vh - 80px);">
        <div style="display: flex; justify-content: center; align-items: center; height: 100%;">
            <div class="animate-pulse text-[var(--text-primary)]">Loading Chemistry Engine...</div>
        </div>
    </div>
  `;

  if (window.mountChemistryGame) {
    window.mountChemistryGame();
    return;
  }

  try {
    const htmlResponse = await fetch('/organic/index.html');
    const htmlText = await htmlResponse.text();
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const href = link.getAttribute('href');
      if (!document.querySelector(link[href="$href"])) {
        const newLink = document.createElement('link');
        newLink.rel = 'stylesheet';
        newLink.href = href;
        document.head.appendChild(newLink);
      }
    });

    doc.querySelectorAll('script').forEach(script => {
      const src = script.getAttribute('src');
      if (src && !document.querySelector(script[src="$src"])) {
        const newScript = document.createElement('script');
        newScript.type = script.getAttribute('type') || 'text/javascript';
        newScript.src = src;
        if (script.hasAttribute('crossorigin')) {
           newScript.crossOrigin = script.getAttribute('crossorigin');
        }
        document.body.appendChild(newScript);
      }
    });
  } catch (error) {
    console.error(error);
    appContainer.innerHTML = <div class="text-center p-8 text-red-500">Failed to load game environment.</div>;
  }
}
