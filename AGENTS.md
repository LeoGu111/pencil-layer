# Pencil Layer auf dem iPad

Das Projekt baut auf dem [Obsidian-Plugin Pencil Layer](https://github.com/standw7/pencil-layer) auf. Ziel ist ein flüssiger Wechsel zwischen Markdown und Apple Pencil, etwa bei handschriftlichen Nebenrechnungen und technischen Skizzen. Beim PDF-Export sollen Text und Zeichnungen auf den vorgesehenen Seiten und an den erwarteten Positionen erscheinen.

## Referenzprojekt Notify

[LeoGu111/Notify](https://github.com/LeoGu111/Notify) ist Leos eigenes Projekt für handschriftliche PDF-Notizen. Lokal liegt eine Arbeitskopie unter `C:\Users\Leona\Notify`. Für diesen Workspace dient Notify als Referenz zum Lesen. Relevante Stellen auf GitHub:

- [Pencil-Gesten](https://github.com/LeoGu111/Notify/blob/main/src/renderer/editor/pencilGestures.ts) und [PDF-Seitenansicht](https://github.com/LeoGu111/Notify/blob/main/src/renderer/components/PdfPage.tsx) für Stift, Finger und Gestenabbruch.
- [Strichglättung](https://github.com/LeoGu111/Notify/blob/main/src/renderer/editor/strokeStabilization.ts) und [Druckverarbeitung](https://github.com/LeoGu111/Notify/blob/main/src/renderer/editor/pressureInk.ts) für das Schreibgefühl.
- [PDF-Export](https://github.com/LeoGu111/Notify/blob/main/src/renderer/editor/exportPdf.ts) für die Übertragung der Zeichnungen in die Ausgabe. Notify arbeitet mit festen PDF-Seiten. Pencil Layer muss zusätzlich mit Zeilenumbruch und dem Layout von Obsidian umgehen.
- [Schreibtest im Browser](https://github.com/LeoGu111/Notify/blob/main/scripts/writing-browser-check.tsx) als Vorlage für reproduzierbare Prüfungen.

## Erster Arbeitsschritt

Sobald Leo den ersten konkreten Fehler oder gewünschten Ablauf beschreibt, mit einer kleinen Testnotiz reproduzieren und die relevante Stelle im Plugin prüfen. Bei Änderungen am Stift mit dem Apple Pencil zeichnen und direkt danach per Finger scrollen. Bei Änderungen am Export dieselbe Notiz in der Editoransicht, im Lesemodus und im PDF vergleichen. Ein Test auf dem echten iPad bleibt für Eingabe und iPad-PDF-Export erforderlich. Vorhandene Obsidian-Notizen mit gespeicherter Handschrift sollen weiterhin geladen werden können.
