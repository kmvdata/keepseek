import type { WebviewFragment } from '../../composition';

export const aboutDeclarationFragment: WebviewFragment = {
  id: 'dialogs.about.declaration',
  source: `
      var aboutOverlay = document.getElementById('aboutDialogOverlay');
      var aboutProductValue = document.getElementById('aboutProductValue');
      var aboutVersionValue = document.getElementById('aboutVersionValue');
      var aboutAuthorValue = document.getElementById('aboutAuthorValue');
      var aboutLicenseValue = document.getElementById('aboutLicenseValue');
      var aboutRepositoryValue = document.getElementById('aboutRepositoryValue');
      var aboutCopyrightValue = document.getElementById('aboutCopyrightValue');
`.slice(1)
};

export const aboutButtonFragment: WebviewFragment = {
  id: 'dialogs.about.button',
  source: `
      var aboutCloseBtn = document.getElementById('aboutCloseBtn');
`.slice(1)
};

export const aboutOpenFragment: WebviewFragment = {
  id: 'dialogs.about.open',
  source: `
      function showAboutDialog() {
        if (!aboutOverlay) { return; }
        var info = getExtensionInfo();
        if (aboutProductValue) {
          aboutProductValue.textContent = info.displayName;
        }
        if (aboutVersionValue) {
          aboutVersionValue.textContent = formatExtensionVersion(info.version);
        }
        if (aboutAuthorValue) {
          aboutAuthorValue.textContent = info.author;
        }
        if (aboutLicenseValue) {
          aboutLicenseValue.textContent = info.license;
        }
        if (aboutRepositoryValue) {
          aboutRepositoryValue.textContent = info.repositoryUrl;
        }
        if (aboutCopyrightValue) {
          aboutCopyrightValue.textContent = 'Copyright (c) 2026 ' + info.author;
        }
        aboutOverlay.classList.remove('hidden');
        if (aboutCloseBtn) {
          aboutCloseBtn.focus();
        }
      }

`.slice(1)
};

export const aboutCloseFragment: WebviewFragment = {
  id: 'dialogs.about.close',
  source: `
      function hideAboutDialog() {
        if (!aboutOverlay) { return; }
        aboutOverlay.classList.add('hidden');
        promptInput.focus();
      }

`.slice(1)
};

export const aboutCloseBindingFragment: WebviewFragment = {
  id: 'dialogs.about.close-binding',
  source: `
      if (aboutCloseBtn) {
        aboutCloseBtn.addEventListener('click', function() {
          hideAboutDialog();
        });
      }

`.slice(1)
};

export const aboutOverlayBindingsFragment: WebviewFragment = {
  id: 'dialogs.about.overlay-bindings',
  source: `
      if (aboutOverlay) {
        aboutOverlay.addEventListener('click', function(event) {
          if (event.target === aboutOverlay) {
            hideAboutDialog();
          }
        });

        aboutOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideAboutDialog();
          }
        });
      }

`.slice(1)
};

