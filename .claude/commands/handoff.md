---
description: Genera un documento de traspaso completo de la sesión actual, listo para continuar el trabajo en una sesión nueva de Claude Code sin perder contexto
argument-hint: [nota u enfoque opcional]
disable-model-invocation: true
effort: high
allowed-tools:
  - Read
  - Write
  - Edit
---

Esta sesión está por quedarse sin espacio de contexto. El usuario va a abrir una sesión nueva de Claude Code —sin memoria de esta conversación— y necesita retomar el trabajo ahí sin perder nada importante. Tu única tarea en este turno es producir ese traspaso: el documento que le permitiría a un colega senior que jamás vio esta conversación seguir exactamente donde la dejaste, sin releer nada y sin adivinar qué se decidió ni por qué.

Nota o enfoque especial que dejó el usuario para este traspaso (ignora esta línea si quedó vacía): $ARGUMENTS

## Estado técnico verificable (úsalo para fundamentar el documento, no lo copies tal cual)

Directorio de trabajo: !`pwd`

¿Repositorio git?: !`git rev-parse --is-inside-work-tree 2>/dev/null || echo "no"`

Rama actual: !`git branch --show-current 2>/dev/null || echo "N/A"`

Último commit: !`git log -1 --oneline 2>/dev/null || echo "N/A"`

Archivos modificados / sin trackear: !`git status --short 2>/dev/null || echo "N/A (no es un repo git)"`

Resumen de cambios sin commitear: !`git diff --stat 2>/dev/null || echo "N/A"`

Últimos commits de esta sesión: !`git log --oneline -10 2>/dev/null || echo "N/A"`

¿.gitignore ya ignora .claude/handoffs/?: !`test -f .gitignore && grep -qx ".claude/handoffs/" .gitignore && echo "sí" || echo "no"`

Ruta absoluta donde debes guardar el traspaso (la carpeta ya quedó creada): !`mkdir -p "$(pwd)/.claude/handoffs" && echo "$(pwd)/.claude/handoffs/HANDOFF_$(date +%Y-%m-%d_%Hh%M).md"`

## Reglas para escribir el traspaso

1. **No hagas preguntas de aclaración.** Este comando existe para preservar contexto, no para gastarlo en ida y vuelta. Cualquier cosa ambigua o sin resolver va anotada en la sección "Dudas abiertas", no como pregunta al usuario.
2. **No inventes ni asumas progreso que no verificaste.** Si no puedes confirmar que algo quedó terminado, funcionando o probado, dilo con esas palabras ("sin verificar", "pendiente de probar"). Un traspaso que exagera avances es más dañino que uno corto pero honesto: la sesión nueva va a construir sobre lo que le digas que ya está hecho.
3. **Prioriza densidad sobre extensión.** No pegues contenido completo de archivos ni salidas largas de comandos o tests: referencia la ruta y resume en una línea. Cada línea que escribas va a ocupar contexto en la sesión nueva.
4. **Ancla el estado técnico en los comandos de arriba**, no solo en tu memoria de la conversación: puede haber cambios en el repositorio que no hiciste directamente vos.
5. Escribe todo en español, igual que el resto de la conversación.

## Estructura exacta del documento

Genera el contenido siguiendo esta plantilla (reemplazá cada sección; no dejes los corchetes en el resultado final):

```
# Traspaso de sesión — [nombre corto de la tarea] — [fecha de hoy]

## 1. Objetivo
[Qué pidió el usuario originalmente y el objetivo de más alto nivel de esta sesión. Contexto de negocio o de proyecto si aplica, en 2-4 líneas.]

## 2. Estado actual
[Checklist honesto: - [x] para lo terminado y verificado, - [ ] para lo que falta o quedó a medias.]

## 3. Decisiones clave y su razón
[Cada decisión de diseño, arquitectura o enfoque no obvia que se tomó durante la sesión, junto con el porqué — para que la sesión nueva no la reconsidere ni la deshaga por accidente.]

## 4. Archivos relevantes
[Ruta de cada archivo creado o modificado, con una línea de qué cambió y por qué importa. No repitas el contenido de los archivos.]

## 5. Estado del repositorio
[Rama, último commit, cambios sin commitear o sin trackear, basado en la salida de git de arriba. Si no es un repositorio git, decilo.]

## 6. Problemas encontrados y cómo se resolvieron
[Bugs, callejones sin salida, enfoques que se probaron y NO funcionaron — para que la sesión nueva no pierda tiempo repitiendo el mismo camino.]

## 7. Próximos pasos
[Lista ordenada y accionable. El primer ítem debe ser lo bastante concreto para que la sesión nueva empiece a trabajar de inmediato, sin tener que decidir por dónde arrancar.]

## 8. Advertencias y restricciones
[Qué NO tocar, convenciones del proyecto que se descubrieron, restricciones que puso el usuario, dependencias externas pendientes, cualquier dato sensible a tener en cuenta.]

## 9. Dudas abiertas
[Preguntas sin resolver o decisiones que le corresponden al usuario. "Ninguna" si no aplica.]

## 10. Mensaje para abrir la sesión nueva
[Un párrafo ya redactado en primera persona del usuario, listo para pegar como primer mensaje de la sesión nueva. Tiene que resumir en un bloque compacto lo imprescindible de las secciones 1, 2, 3 y 7, y terminar diciendo con qué próximo paso empezar.]
```

## Al terminar

1. Guardá el documento completo en la ruta absoluta indicada arriba, usando la herramienta Write.
2. Si la respuesta sobre `.gitignore` fue "no" y existe un archivo `.gitignore` en la raíz del proyecto, agregale una línea con `.claude/handoffs/` al final usando Edit. Si no existe `.gitignore`, no lo crees ni lo menciones.
3. Mostrá el documento completo en tu respuesta, dentro de un bloque de código markdown, para que se pueda copiar directo sin depender del archivo.
4. Cerrá con una línea que diga la ruta exacta donde quedó guardado y recuerde las dos formas de continuar: pegar el documento como primer mensaje de la sesión nueva, o abrirla y escribir `@` seguido del inicio del nombre del archivo para adjuntarlo.
