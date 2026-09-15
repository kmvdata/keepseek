import type { WebviewFragment } from '../composition';

export const referenceCodecFragment: WebviewFragment = {
  id: 'references.codec',
  source: `
      function addPlainTextReferences(references, seen, value, allowPlainTextPaths) {
        if (!value) { return; }
        var entries = splitDragLines(value).map(function (entry) {
          return entry.trim();
        }).filter(function (entry) {
          return entry && entry.charAt(0) !== '#';
        });
        if (!entries.length) { return; }

        for (var i = 0; i < entries.length; i++) {
          var reference = normalizePlainTextReference(entries[i], allowPlainTextPaths);
          if (!reference) { continue; }
          var key = reference.kind === 'directory' ? makeDirectoryHref(reference) : makeFileHref(reference);
          if (seen[key]) { continue; }
          seen[key] = true;
          references.push(reference);
        }
      }

      function splitDragLines(value) {
        return String(value || '')
          .split(String.fromCharCode(13)).join('')
          .split(String.fromCharCode(10));
      }

      function normalizePlainTextReference(value, allowPlainTextPaths) {
        var text = String(value || '').trim().split(String.fromCharCode(0)).join('');
        if (!text) { return null; }
        if (startsWithFileScheme(text)) {
          return fileUriToReference(text);
        }

        var target = getStandaloneBracketReferenceTarget(text);
        if (!target) {
          return allowPlainTextPaths ? normalizeDraggedReference(text) : null;
        }
        if (!isSafePlainFileReferenceTarget(target)) { return null; }
        var directoryPrefix = 'keepseek-dir:';
        if (target.toLowerCase().indexOf(directoryPrefix) === 0) {
          var directoryPath = target.slice(directoryPrefix.length).trim();
          if (!directoryPath) { return null; }
          return { path: directoryPath, kind: 'directory', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
        }
        if (startsWithFileScheme(target)) {
          return fileUriToReference(target);
        }

        var split = splitLineReference(target);
        if (!split.path || isSingleSegmentClosingTagPath(split.path)) { return null; }
        return {
          path: split.path,
          startLine: split.startLine,
          endLine: split.endLine,
          startColumn: split.startColumn,
          endColumn: split.endColumn
        };
      }

      function getStandaloneBracketReferenceTarget(value) {
        var text = String(value || '').trim();
        if (text.length < 3 || text.charAt(0) !== '<' || text.charAt(text.length - 1) !== '>') {
          return '';
        }
        var target = text.slice(1, -1).trim();
        if (!target || target.indexOf('<') >= 0 || target.indexOf('>') >= 0) {
          return '';
        }
        return target;
      }

      function isSafePlainFileReferenceTarget(value) {
        var text = String(value || '').trim();
        if (!text) { return false; }
        if (text.indexOf('"') >= 0 || text.indexOf("'") >= 0 || text.indexOf(String.fromCharCode(96)) >= 0 || /\\s+\\S+=/.test(text)) {
          return false;
        }
        for (var i = 0; i < text.length; i++) {
          var code = text.charCodeAt(i);
          if (code < 32 || code === 127) { return false; }
        }
        return true;
      }

      function normalizeDraggedReference(value) {
        var text = String(value || '').trim().split(String.fromCharCode(0)).join('');
        if (!text) { return null; }
        if (startsWithFileScheme(text)) {
          return fileUriToReference(text);
        }

        var split = splitLineReference(text);
        if (!isAbsolutePath(split.path)) { return null; }
        return {
          path: split.path,
          startLine: split.startLine,
          endLine: split.endLine,
          startColumn: split.startColumn,
          endColumn: split.endColumn
        };
      }

      function startsWithFileScheme(value) {
        return value.toLowerCase().indexOf('file:') === 0;
      }

      function isSingleSegmentClosingTagPath(value) {
        var text = String(value || '').trim();
        if (text.charAt(0) !== '/' || text.indexOf('/', 1) >= 0 || text.indexOf('.') >= 0) {
          return false;
        }
        var name = text.slice(1);
        if (!name) { return false; }
        for (var i = 0; i < name.length; i++) {
          var code = name.charCodeAt(i);
          var allowed = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            name.charAt(i) === '_' ||
            name.charAt(i) === '-' ||
            name.charAt(i) === ':';
          if (!allowed) { return false; }
        }
        return true;
      }

      function splitLineReference(value) {
        for (var i = value.length - 1; i >= 0; i--) {
          if (value.charAt(i) !== '#') { continue; }
          var parsed = parseLineRange(value.slice(i + 1));
          if (parsed.valid) {
            return {
              path: value.slice(0, i),
              startLine: parsed.startLine,
              endLine: parsed.endLine,
              startColumn: parsed.startColumn,
              endColumn: parsed.endColumn
            };
          }
        }
        return { path: value, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }

      function parseLineRange(fragment) {
        var text = String(fragment || '').trim();
        if (!text) {
          return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
        }
        if (text.charAt(0).toLowerCase() === 'l') {
          text = text.slice(1);
        }

        var start = readLeadingInteger(text);
        if (!start.valid) {
          return { valid: false, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };
        }

        var startLine = start.value;
        var startColumn = 0;
        var rest = start.rest;

        if (rest.charAt(0).toLowerCase() === 'c') {
          var col = readLeadingInteger(rest.slice(1));
          if (col.valid) {
            startColumn = col.value;
            rest = col.rest;
          }
        }

        if (rest.charAt(0) === '-' || rest.charAt(0) === ',' || rest.charAt(0) === ':') {
          rest = rest.slice(1);
        } else {
          return { valid: true, startLine: startLine, endLine: startLine, startColumn: startColumn, endColumn: startColumn };
        }

        var endLine = startLine;
        var endColumn = 0;

        if (rest.charAt(0).toLowerCase() === 'l') {
          var endLineResult = readLeadingInteger(rest.slice(1));
          if (endLineResult.valid) {
            endLine = endLineResult.value;
            rest = endLineResult.rest;
            if (rest.charAt(0).toLowerCase() === 'c') {
              var endColResult = readLeadingInteger(rest.slice(1));
              if (endColResult.valid) {
                endColumn = endColResult.value;
              }
            }
          }
        } else if (rest.charAt(0).toLowerCase() === 'c') {
          var endColResult = readLeadingInteger(rest.slice(1));
          if (endColResult.valid) {
            endColumn = endColResult.value;
          }
        } else {
          var endResult = readLeadingInteger(rest);
          if (endResult.valid) {
            endLine = endResult.value;
          }
        }

        if (endLine < startLine) {
          endLine = startLine;
        }

        return {
          valid: true,
          startLine: startLine,
          endLine: endLine,
          startColumn: startColumn,
          endColumn: endColumn
        };
      }

      function readLeadingInteger(value) {
        var digits = '';
        for (var i = 0; i < value.length; i++) {
          var code = value.charCodeAt(i);
          if (code < 48 || code > 57) { break; }
          digits += value.charAt(i);
        }
        if (!digits) {
          return { valid: false, value: 0, rest: value };
        }
        return {
          valid: true,
          value: Math.max(1, Number(digits)),
          rest: value.slice(digits.length)
        };
      }

      function isAbsolutePath(value) {
        var slash = '/';
        var backslash = String.fromCharCode(92);
        var first = value.charAt(0);
        var second = value.charAt(1);
        var third = value.charAt(2);
        return (first === slash && second !== slash) ||
          (first === slash && second === slash && third !== slash) ||
          (first === backslash && second === backslash && third !== backslash) ||
          isWindowsDrivePath(value);
      }

      function isWindowsDrivePath(value) {
        if (value.length < 3 || value.charAt(1) !== ':') { return false; }
        var firstCode = value.charCodeAt(0);
        var isLetter = (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
        var separator = value.charAt(2);
        return isLetter && (separator === '/' || separator === String.fromCharCode(92));
      }

      function fileUriToReference(uri) {
        try {
          var url = new URL(uri);
          if (url.protocol !== 'file:') { return null; }
          var pathname = decodeURIComponent(url.pathname);
          var parsed = parseLineRange(url.hash ? url.hash.slice(1) : '');
          var startLine = parsed.valid ? parsed.startLine : 0;
          var endLine = parsed.valid ? parsed.endLine : startLine;
          var startColumn = parsed.valid ? parsed.startColumn : 0;
          var endColumn = parsed.valid ? parsed.endColumn : 0;
          if (url.hostname) {
            return { path: '//' + url.hostname + pathname, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
          }
          if (pathname.charAt(0) === '/' && isWindowsDrivePath(pathname.slice(1))) {
            return { path: pathname.slice(1), startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
          }
          return { path: pathname, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
        } catch (error) {
          var split = splitLineReference(uri);
          var fallback = split.path.split('?')[0];
          if (fallback.startsWith('file:///') && isWindowsDrivePath(fallback.slice(8))) {
            return {
              path: decodeURIComponent(fallback.slice(8)),
              startLine: split.startLine,
              endLine: split.endLine,
              startColumn: split.startColumn,
              endColumn: split.endColumn
            };
          }
          if (fallback.startsWith('file://')) {
            return {
              path: decodeURIComponent(fallback.slice(7)),
              startLine: split.startLine,
              endLine: split.endLine,
              startColumn: split.startColumn,
              endColumn: split.endColumn
            };
          }
        }
        return null;
      }

`.slice(1)
};

