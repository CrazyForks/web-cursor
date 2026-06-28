"use client";

type ImportMap = {
  imports: Record<string, string>;
};

function addModulePreload(href: string) {
  const id = `modulepreload:${href}`;
  if (document.getElementById(id)) return;

  const link = document.createElement("link");
  link.id = id;
  link.rel = "modulepreload";
  link.href = href;
  document.head.appendChild(link);
}

export function preloadImportMap(importMap: ImportMap) {
  const imports = importMap.imports;
  const urls = [
    imports.react,
    imports["react/"] ? `${imports["react/"]}jsx-runtime` : undefined,
    imports["react-dom"],
    imports["react-dom/"] ? `${imports["react-dom/"]}client` : undefined,
  ];

  for (const url of urls) {
    if (url) addModulePreload(url);
  }
}
