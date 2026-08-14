# JobFill — полный технический аудит

**Дата:** 14 августа 2026
**Версия проекта:** 1.0.0 (commit `3f5ddaf`)
**Метод:** чтение всего исходного кода (~1900 строк), запуск всей тулчейн-цепочки (`compile` / `lint` / `test` / `build`), рендер собранных страниц расширения в headless Chrome со стабом `chrome.*` API, измерение layout-метрик и контрастности по WCAG 2.1.

---

## Статус исправлений

> **Как читать этот документ.** Разделы §0–§9 ниже — это снимок состояния **до**
> работ по устранению найденного. Они намеренно не переписаны: ценность аудита в
> том, что дефекты зафиксированы вместе с тем, как они выглядели. Эта таблица
> превращает документ в трекер: она говорит, что из найденного уже неверно, а что
> всё ещё в силе.
>
> Правило заполнения: статус ставится только по коду или по собранному манифесту,
> никогда по намерению. «Осознанно отложено» — это не «не успели», а решение,
> у которого записана цена; такие пункты продублированы в ТЗ, §11.1 «Accepted
> Trade-offs», чтобы их не переоткрыли как баги.

### P0 — блокеры релиза

| Пункт | Статус | Чем подтверждено |
|---|---|---|
| **P0-1** CI красный, 3 шага из 5 падают | **исправлено** | Все пять шагов зелёные, проверено запуском: `npm run lint` — 0 ошибок (было 11 425); `npm run compile` — 0 ошибок; `npm run coverage` — **609 тестов в 10 файлах**, exit 0, пороги проходят; `npm run build` и `npm run build:firefox` — успешны. Покрытие `shared/**`: **91.31% строк, 89.68% statements, 84% branches, 84.96% functions** (было 553 теста / 91% / 89.2% / 82.91% / 84.61%). Пороги в `vitest.config.ts` двухуровневые: проценты по директориям + репозиторный бюджет непокрытого кода (отрицательные значения). Цифры покрытия — храповик: их надо снижать по мере появления тестов. |
| **P0-2** v5 недостижим из UI | **исправлено** | `entrypoints/popup/App.tsx` → `handleLogApplication` шлёт `LOG_APPLICATION`; `entrypoints/background.ts` → `handleLogApplication` пишет локальную копию и ставит ретрай. Это единственный путь создания `ApplicationEntry`. |
| **P0-3** `<all_urls>` + `all_frames` вопреки NFR-2 | **частично / осознанно отложено** | В собранном `manifest.json`: `matches` = `http://*/*` + `https://*/*`, восемь `exclude_matches`, семь `exclude_globs`. Перехода на `activeTab` + `chrome.scripting.executeScript` **нет** — он ломает inline-кнопку. Причина и цена записаны в ТЗ NFR-2 и §11.1 (T-1). `all_frames: true` сохранён. Зато набор разрешений в итоге **сузился**, а не вырос, как было на прошлой сверке: `permissions` = `storage`, `activeTab`, `alarms` — и всё, в обеих сборках (проверено `python3 -m json.tool` по обоим собранным манифестам). `webNavigation` удалён (см. P0-5), `scripting` удалён (нигде не вызывался: `grep -rn "chrome.scripting" entrypoints shared` — два попадания, оба в комментарии-плане внизу `content.ts`). Ни одно из трёх оставшихся разрешений не показывает предупреждения при установке в Chrome. |
| **P0-4** кнопка «⚡ Fill» у полей пароля | **исправлено** | `shared/filler/fillable.ts` — allowlist типов инпутов, `password` вне его; `looksLikeAuthPage()` не даёт вооружить кнопку на странице логина вообще. Тесты: «never enumerates the password or verify-password fields» (Workday), «does not enumerate the login password» (job-search). |
| **P0-5** ответ приходит не из того фрейма | **исправлено, без разрешения** | Схема переделана: направление ответа развёрнуто. Со стороны страницы (`entrypoints/content.ts`, `installMessageBridge`): фрейм, которому нечего сказать, не отвечает вовсе, а тот, которому есть что сказать, отвечает через `chrome.runtime.sendMessage`, **не** через `sendResponse` — поэтому ни один ответ не затирает другой. Со стороны вызывающего (`entrypoints/ui/frames.ts`): одна широковещательная `tabs.sendMessage` с уникальным `requestId`, приём на `chrome.runtime.onMessage`, фильтр по `requestId` и по вкладке, агрегация. Номер ответившего фрейма берётся из `sender.frameId` — ровно то, за чем раньше ходили в `getAllFrames`. Id открытых вопросов по-прежнему неймспейсятся id фрейма. **Разрешение `webNavigation` из манифеста удалено** (проверено по обоим собранным манифестам): новой схеме разрешения не нужны вообще, и она сильнее прежней — отчитываются все фреймы, а не самый быстрый. Цена — в строке ниже. |
| **P0-5, цена** | **принято осознанно** | Без перечисления фреймов неизвестно, сколько ответов ждать, поэтому окно сбора `COLLECT_WINDOW_MS = 400` мс **и есть** условие завершения, а не подстраховка. Фрейм, ответивший позже, свои поля заполнит и подсветит (это происходит внутри фрейма), но в сводку попапа не попадёт. Окно не выжидается, когда Chrome сообщает, что во вкладке нет ни одного слушателя. Записано в ТЗ §11.1 как T-6. |
| **P0-6** Firefox: `storage.sync` не работает | **исправлено** | `browser_specific_settings.gecko` c `id: jobfill@diz1l.dev` и `strict_min_version: 109.0` присутствует в `.output/firefox-mv2/manifest.json`. Замечание про утечку `scripting` в MV2 закрыто вместе с самим разрешением: `permissions` MV2-сборки теперь `storage`, `activeTab`, `alarms` + четыре хоста (в MV2 хосты лежат в том же массиве). MV3-только API в MV2-манифесте не осталось. |
| **P0-7** Sheets-логирование сломано редиректом | **исправлено** | `https://script.googleusercontent.com/*` есть в обеих сборках — в MV3 в `host_permissions`, в MV2 в общем массиве `permissions`; `shared/api/sheets.ts` явно допускает оба хоста и сохраняет `redirect: 'follow'`. |

### P1 — качество ядра и данных

| Пункт | Статус | Чем подтверждено |
|---|---|---|
| **P1-1** ложные срабатывания `fullName` | **исправлено** | `dictionary.ts`: правило получило `negative` из `NON_PERSON_NAME` (`file name`, `project name`, `city name`, …) плюс owner-контексты `company / organisation / referral / referee / emergency`. Тест Lever: «leaves "Current company" alone». |
| **P1-2** `city` матчит `location` | **исправлено** | Введены `weak`-паттерны с урезанными весами и `isSearchContext()` в `fingerprint.ts`. Проверено: фильтр «Location» на странице поиска даёт `confidence: 'low'`. |
| **P1-3** скоринг без защиты от «почти-ничьей» | **исправлено** | `scorer.ts`: `MIN_MARGIN = 15`, при отрыве меньше — понижение до `low`. |
| **P1-4** `getContextHeading` — источник шума | **исправлено** | Переписан: `<fieldset>/<legend>`, ограничения `MAX_ANCESTOR_DEPTH` / `MAX_SIBLING_SCAN` / `MAX_FALLBACK_DEPTH`, отбрасывание текста, дублирующего label. Есть тест бюджета NFR-3 на 200 контролов. |
| **P1-5** `aria-labelledby` как список ID | **исправлено** | Тест Workday: «reads the label out of the aria-labelledby ID list, dropping the required marker text». |
| **P1-6** детект открытых вопросов слишком узкий | **исправлено** | `scorer.ts` смотрит `labelText`, `ariaLabel`, `contextHeading`, `placeholder`; вопросительный знак достаточен на любом контроле. Тесты Workday и Lever («routes the opaque custom question to the AI path via its sibling div»). |
| **P1-7** импорт пишет непроверенный JSON | **исправлено** | `shared/storage/validate.ts` (324 строки, без рантайм-зависимости): строгий режим для импорта, мягкий для чтения, миграции по `schemaVersion`, ошибки с указанием пути. |
| **P1-8** read-modify-write без блокировок | **исправлено, с остаточным компромиссом** | `shared/storage/sync.ts` — ключ на сущность (`jobfill.profile.<id>` и т. д.) плюс очередь записей внутри контекста. Одновременная правка **одного и того же** профиля остаётся last-write-wins: в `chrome.storage` нет CAS-примитива. Записано в ТЗ §11.1 (T-2). |
| **P1-9** нет ретрая для удалённого логирования | **исправлено** | `shared/storage/retryQueue.ts` (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 60 000`) + драйвер на `chrome.alarms` в `background.ts`; статус `pending` теперь реально используется, добавлен статус `off`. |
| **P1-10** мёртвый код | **частично** | Подключено: `API_ERROR_MESSAGES` (используется в `background.ts`), `getStorageUsage` (`options/App.tsx` — FR-1.2 закрыт), `removeAllHighlights` (teardown в `content.ts`). **`CLASSIFY_FIELDS` больше не мёртв** — отправитель есть (`entrypoints/content.ts:410`), см. отдельную строку про FR-5.3 ниже. **`serializeFingerprint` больше не мёртв** — вызывается из `buildClassificationBatch` (и через него из второго прохода), в него добавлен `semanticName`: 9 компонентов вместо 8. **`inspectNotionDatabase` / `describeMapping` / `validateSheetsEndpoint` больше не мертвы** — см. P1-13. Осталось: `upsertProfile` / `deleteProfile` / `upsertCoverTemplate` / `deleteCoverTemplate` не вызываются из UI (он пишет списком через `saveProfiles`). Это единственное, что осталось от пункта. |
| **FR-5.3** подключён (бывший «осталось открытым» №1) | **исправлено** | Настройка `AppSettings.llmFieldClassification` (по умолчанию `false`, fail-closed в `validate.ts`) + тумблер на вкладке «API & Logging», заблокированный до сохранения ключа Groq. Второй проход в `entrypoints/content.ts` (`runClassificationPass`) после эвристического заполнения, запускается без `await`. Лимит партии `MAX_CLASSIFY_FIELDS = 40` — и на сборке партии, и повторно на выходе в `shared/api/groq.ts`. Опт-ин проверяется дважды: в content-скрипте и в воркере (`background.ts:311`), потому что ключ принадлежит воркеру. Потолок уверенности `medium` гарантирован типом: `LlmFieldConfidence = Extract<FieldConfidence, 'medium'>` — у типа ровно один обитатель, параметра уверенности на этом пути нет. **Важно для читателя UI: обратная связь второго прохода живёт на странице (янтарная подсветка + тост), а не в попапе** — ответ модели приходит через секунды после закрытия окна сбора в 400 мс. Счётчики попапа остаются эвристическим снимком и хиты классификатора не учитывают. Это не баг, записано в ТЗ §11.1 как T-7. |
| **P1-11** фикстуры синтетические | **исправлено** | Добавлены `tests/fixtures/greenhouse-real.html`, `lever.html`, `workday.html`, `job-search.html` с обфусцированными атрибутами, `aria-labelledby`-списками, свёрнутыми секциями и полями пароля. |
| **P1-12** `FILL_COVER_TEXT` целится наугад | **исправлено** | `shared/filler/coverTarget.ts`: запоминание сфокусированного поля до открытия попапа + распознанное поле; при отсутствии кандидата текст не вставляется никуда и возвращается ошибка. |
| **P1-13** Notion-схема захардкожена | **исправлено и доведено до UI** | `shared/api/notion.ts` вырос с 35 до 379 строк: чтение схемы базы, кэш, сопоставление свойств, отдельное сообщение о том, чего не хватает. На прошлой сверке всё это было недостижимо из интерфейса — теперь нет. На вкладке «API & Logging» есть кнопка «Check connection» (`entrypoints/ui/NotionCheck.tsx`), показывающая построчное сопоставление свойств базы с тем, что JobFill собирается писать, и отдельно помечающая единственный обязательный слот `title`. Sheets-эндпоинт валидируется `validateSheetsEndpoint` **до** сохранения, и невалидный блокирует сохранение (`options/App.tsx`, `handleSave`) — раньше первым признаком неверного URL был неудавшийся лог заявки. Маршрут проверки: сообщение `INSPECT_NOTION` → `NOTION_SCHEMA_RESULT` / `NOTION_SCHEMA_ERROR` в `shared/messages.ts`, обработчик `handleInspectNotion` в `entrypoints/background.ts:335`. |
| **P1-13, почему через воркер** | — | Не только из-за S-2 (страница расширения могла бы сходить в Notion сама: свой origin, хост в `host_permissions`, чужой CSP/CORS не применяется). Главная причина в том, что **кэш схемы в `shared/api/notion.ts` — модульное состояние**: проверка со страницы прогрела бы копию страницы настроек, которую путь записи в воркере никогда не увидит, и, значит, ничего не доказывала бы про тот код, который реально пишет. Через воркер проверка работает с тем же экземпляром модуля и тем же кэшем. Обработчик обязан звать `clearNotionSchemaCache(databaseId)` первым — иначе повторная проверка после починки базы отдаст закэшированный на 10 минут провал и кнопка будет выглядеть сломанной. В `entrypoints/ui/notionConnection.ts` остаётся фолбэк на прямой вызов со страницы, если обработчик не ответил. |

### §5 — дизайн

| Пункт | Статус | Чем подтверждено |
|---|---|---|
| **§5.1** сломан app-shell настроек | **исправлено** | `globals.css`: `html.page, body, #root { height: 100%; overflow: hidden }`; `<main class="min-w-0 flex-1 overflow-y-auto">` — единственный скролл-контейнер. |
| **§5.2** поля на всю ширину (1076 px) | **исправлено** | Токены `--container-content: 900px`, `--field-min: 280px`; классы `.content-column` и `.field-grid` (`repeat(auto-fill, minmax(280px, 1fr))`). |
| **§5.3** разная ширина вкладок | **исправлено** | `max-w-lg` из `ApiTab` убран, все вкладки рендерятся внутри одного `.content-column` (комментарий в `options/App.tsx` со ссылкой на §5.3). |
| **§5.4** контраст не проходит WCAG AA | **исправлено** | Палитра переехала в `@theme`. Пересчёт по WCAG 2.1 для пар, которые реально встречаются в компонентах: худшая текстовая — 4.59:1 (тёмная тема) и 4.54:1 (светлая), худшая нетекстовая — 3.28:1. Формально «плохие» комбинации `fg-subtle`/`surface-active` (4.14:1) и `line-strong`/`surface-active` (2.96:1) в коде не встречаются: `surface-active` используется только в `.nav-item-active`, где текст — `--color-fg` (9.42:1). |
| **§5.4-бис** подсветка полей **на странице** не проходила 3:1 (в исходном аудите не зафиксировано — найдено позже) | **исправлено** | Палитра `shared/filler/highlight.ts` была скопирована с UI-токенов: `#22c55e` / `#eab308` / `#9ca3af` дают на белом фоне 2.28 / 1.92 / 2.54 — то есть на обычной светлой странице вакансии подсветка была практически невидима, и сигнал «проверь это» для `medium`-заполнения до пользователя не доходил (тихая поломка FR-3.5). Новый набор подобран под худший из двух случаев сразу — и против белого, и против почти-чёрного: `high #16a34a` (3.30 / 5.73), `medium #a16207` (4.92 / 3.84), `none #6b7280` (4.83 / 3.91), `ai #7c3aed` (5.70 / 3.31), `file #2563eb` (5.17 / 3.65). Все ≥ 3:1 по обеим сторонам. Значения и расчёт — в комментарии над `HIGHLIGHT_CSS`. **Токены UI расширения и палитра подсветки страницы намеренно разные и должны такими остаться:** у первых фон известен и есть две темы по `prefers-color-scheme`, у вторых фон принадлежит чужой странице и не запрашивается ниоткуда. |
| **§5.5** фокус невидим | **исправлено** | Глобальное `:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px }` — нулевая специфичность, снять нельзя, только переопределить. `--color-focus` даёт ≥5:1 к любой поверхности. Отдельно введена утилита `transition-theme` — копия `transition-colors` **без `outline-color`**, иначе кольцо фокуса проявлялось бы 150 мс. |
| **§5.6** попап мигает «No profiles yet» | **исправлено** | Третье состояние: `status === 'loading'` → `<PopupSkeleton />` до первого чтения storage. |
| **§5.7** скролл в попапе — мёртвый код | **исправлено** | `html.popup` задаёт `width: var(--container-popup)` и `max-height: var(--popup-height)`, поэтому `overflow-y-auto` у контентной области наконец включается. |
| **§5.8** магические числа вместо системы | **исправлено** | `grep -E "#[0-9a-fA-F]{3,8}"` и `grep -E "\[[0-9]+px\]"` по `entrypoints/**/*.tsx` — 0 совпадений. Все значения — токены `@theme`. Исключение задокументировано: `shared/filler/highlight.ts` рисует на чужих страницах и держит свою палитру. |
| **§5.9** настройки открываются двумя способами | **исправлено** | `chrome.windows.create` заменён на `chrome.runtime.openOptionsPage()`; `<meta name="manifest.open_in_tab" content="true">` в `entrypoints/options/index.html` — в собранном манифесте `options_ui.open_in_tab: true` присутствует. |
| **§5.10** мелочи | **исправлено** | `entrypoints/ui/Icons.tsx` — инлайновые SVG вместо `⚙`/`⚡`; `entrypoints/ui/Dialog.tsx` на нативном `<dialog>` вместо `confirm()`/`alert()`; ссылка на Instagram удалена; `.select` перестилизован; `color-scheme: light dark` + полная светлая палитра; `EmptyState` для пустых списков; ручка ресайза получила `role="separator"`, `tabIndex`, `aria-valuenow`, `onKeyDown` и сохранение ширины в `localStorage`. |

### Что осталось открытым

Закрыто с прошлой сверки и убрано из этого списка: FR-5.3 подключён; `scripting`
удалён из обеих сборок (вместе с ним — утечка в MV2); `webNavigation` удалён, и
набор разрешений впервые сузился. Подтверждения — в таблицах выше.

1. **Осталось от P1-10:** `upsertProfile` / `deleteProfile` / `upsertCoverTemplate` / `deleteCoverTemplate` не вызываются из UI — он пишет списком через `saveProfiles`. Это не дефект пользователя, но это API, которое покрыто тестами и не покрыто применением: либо перевести UI на точечные записи (и заодно уменьшить окно last-write-wins из T-2), либо удалить.
2. **NFR-2 по существу не выполнен и не будет** — content script остаётся декларативным, а не инъектируемым по `activeTab`. Разрешения сузили до предела, но `matches: http://*/*, https://*/*` + `all_frames: true` остались. Это T-1, решение с записанной ценой, а не задолженность. Для Web Store нужно обоснование именно по широте content script, а не по permissions — там теперь чисто.
3. **Сводка попапа не учитывает второй проход FR-5.3** (T-7) и **теряет фреймы, ответившие позже 400 мс** (T-6). Оба — принятые компромиссы, оба видны пользователю как «цифра меньше, чем подсвечено на странице». Если когда-нибудь появится жалоба, начинать надо отсюда, а не с поиска бага в счётчиках.
4. **Неравномерное покрытие.** `shared/filler`, `shared/extractors` и `shared/field-matcher` — 100% строк и закрыты процентными порогами. Слабые места по последнему прогону: `shared/storage` — 79.69% строк (внутри `local.ts` — 58.82%, `sync.ts` — 76.87%), `shared/api` — 86.86% (внутри `groq.ts` — 68.18%); они удерживаются только бюджетом непокрытого кода. E2E-тестов (Playwright с реально загруженным расширением) по-прежнему нет.
5. **Privacy policy не захостена** — для Web Store нужен URL, а не файл в репозитории. Сам текст обновлён под FR-5.3: там теперь три случая отправки данных со страницы, а не два.
6. **Ручной прогон по тест-матрице (M5) не выполнялся** после переработки движка — чек-листы §10 ТЗ остаются неотмеченными сознательно. Второй проход FR-5.3 живьём против настоящей ATS-формы тоже никем не проверялся: он покрыт юнит-тестами с подставным транспортом, но ни одного реального ответа Groq в этом пути ещё не видели.
7. **Устаревший комментарий в коде.** `entrypoints/ui/notionConnection.ts` (шапка модуля, ~строки 26–41) до сих пор утверждает, что обработчика `INSPECT_NOTION` в `entrypoints/background.ts` «ещё нет» и что вызов пока идёт со страницы. Обработчик есть (`background.ts:335`), маршрут по умолчанию — воркер, а вызов со страницы стал фолбэком. Код работает правильно, врёт только комментарий — но врёт ровно в том месте, куда полезет следующий читатель. Правится одной правкой в файле кода, поэтому здесь только зафиксировано.

> Матрица соответствия ТЗ в §6 ниже **не обновлялась** — она относится к состоянию
> до работ. Актуальные статусы: эта таблица и таблица «Release Plan Overview» в
> `TZ_jobfill_extension.md`.

---

## 0. Вердикт одной страницей

> *Ниже — состояние на момент аудита (до исправлений). См. «Статус исправлений» выше.*

| Направление | Оценка | Комментарий |
|---|---|---|
| Архитектура и разделение слоёв | **8.5 / 10** | Чистое: `entrypoints/` — только оркестрация, вся логика — чистые функции в `shared/`. Это правильно. |
| Типизация и контракты | **8 / 10** | Discriminated unions для сообщений, типизированные обёртки над storage. Хорошо. |
| Качество ядра (детектор полей) | **6 / 10** | Работает, но есть ложные срабатывания и нет защиты от «почти-ничьих». |
| Соответствие своему же ТЗ | **5 / 10** | Заявлено «v1–v5 shipped», по факту v5 (логирование заявок) физически недостижим из UI. |
| CI / готовность к релизу | **2 / 10** | **CI красный: 3 из 5 шагов падают.** Публиковать нельзя. |
| Безопасность / приватность / Web Store | **3 / 10** | `<all_urls>` + `all_frames` вопреки собственному NFR-2; кнопка вставки появляется рядом с полями паролей на всех сайтах. |
| **Дизайн и UI** | **3 / 10** | **Ломается разметка на обеих страницах, контраст не проходит WCAG AA, нет дизайн-системы.** Подробно в §5. |

**Главный вывод:** фундамент (архитектура, типы, чистые функции, WXT) — хороший и его надо сохранить. Всё, что сверху — сборка, дизайн, безопасность, конформность ТЗ — требует переделки. Это не «переписать с нуля», это «починить и достроить».

---

## 1. Полная структура проекта

```
JobFill/
│
├── entrypoints/                     ← точки входа расширения (только оркестрация)
│   ├── background.ts        150 стр  Service worker (MV3). Единственная точка сетевого выхода.
│   │                                 Роутинг 4 сообщений: GENERATE_COVER, ANSWER_QUESTIONS,
│   │                                 CLASSIFY_FIELDS, LOG_APPLICATION.
│   ├── content.ts           185 стр  Content script. Enumerate → score → fill → highlight.
│   │                                 Inline-кнопка «⚡ Fill» на focusin. matches: <all_urls>.
│   ├── popup/
│   │   ├── App.tsx          295 стр  React 19. Fill / AI / список заявок. Ширина 380px.
│   │   ├── main.tsx          10 стр  createRoot + StrictMode
│   │   └── index.html        12 стр
│   └── options/
│       ├── App.tsx          475 стр  3 вкладки: Profiles / Templates / API & Logging.
│       │                             Ресайзабельный сайдбар (mousemove).
│       ├── main.tsx          10 стр
│       └── index.html        12 стр
│
├── shared/                          ← вся бизнес-логика, чистые функции, тестируемо
│   ├── types.ts             132 стр  Profile, CoverTemplate, ApplicationEntry, SyncData,
│   │                                 LocalData, FillSummary, JobInfo + дефолты
│   ├── messages.ts           61 стр  Типизированный контракт сообщений (discriminated unions)
│   │
│   ├── field-matcher/               ← движок распознавания полей
│   │   ├── dictionary.ts    101 стр  14 правил EN+CS: regex + autocomplete. Вынесен в конфиг ✅
│   │   ├── fingerprint.ts   132 стр  Сбор отпечатка поля (name/id/label/aria/placeholder/heading),
│   │   │                             extractSemanticName() — де-обфускация атрибутов
│   │   ├── scorer.ts         88 стр  Весовая лестница 70/30/25/20/20/15/10, пороги 70/35
│   │   └── index.ts          13 стр  Barrel-экспорт
│   │
│   ├── filler/                      ← запись значений в DOM
│   │   ├── setNativeValue.ts  18 стр Native setter + синтетические input/change (React-safe) ✅
│   │   ├── selectStrategy.ts  55 стр Подбор <option> по нормализованному сходству, порог 0.5
│   │   ├── highlight.ts       84 стр CSS-классы __jobfill-*, авто-снятие через N мс
│   │   ├── inlineButton.ts   147 стр Плавающая кнопка + toast, инжект <style> в страницу
│   │   └── index.ts          107 стр fillPage() — главный оркестратор заполнения
│   │
│   ├── extractors/                  ← извлечение данных о вакансии
│   │   ├── jsonLd.ts          55 стр JSON-LD JobPosting (+ обход @graph) — приоритет 1
│   │   ├── openGraph.ts       40 стр og:title / og:site_name — приоритет 2
│   │   ├── headingHeuristics.ts 30 стр h1 + document.title — приоритет 3
│   │   └── index.ts           24 стр Цепочка фолбэков
│   │
│   ├── storage/
│   │   ├── sync.ts          110 стр  chrome.storage.sync — профили, шаблоны, настройки
│   │   └── local.ts          83 стр  chrome.storage.local — секреты + журнал заявок
│   │
│   └── api/
│       ├── groq.ts          234 стр  generateMotivation / classifyFields / answerOpenQuestions
│       ├── notion.ts         35 стр  POST /v1/pages с захардкоженной схемой свойств
│       └── sheets.ts         18 стр  POST на Apps Script Web App
│
├── tests/
│   ├── field-matcher.test.ts 253 стр  ~24 теста
│   ├── extractors.test.ts    150 стр  ~12 тестов
│   └── fixtures/                      4 файла × ~55 строк — СИНТЕТИЧЕСКИЕ, не реальная разметка
│       ├── linkedin.html  greenhouse.html  jobs-cz.html  startupjobs.html
│
├── assets/styles/globals.css  48 стр  Tailwind v4 + 6 component-классов (.input/.btn-primary/...)
├── public/icons/                      4 PNG (16/32/48/128)
├── scripts/generate-icons.js 160 стр  Генератор иконок (CommonJS — падает в ESLint)
│
├── wxt.config.ts             38 стр  Манифест + Tailwind-плагин
├── tsconfig.json / eslint.config.js / vitest.config.ts / .prettierrc
├── .github/workflows/ci.yml  64 стр  lint → typecheck → test → build ×2, release по тегу
│
├── README.md                120 стр
├── TZ_jobfill_extension.md  458 стр  Полное ТЗ v1.0 (качественное!)
├── privacy-policy.md         21 стр
│
└── ⚠️ МУСОР В РЕПОЗИТОРИИ (в .gitignore, но на диске):
    ├── testForB/          2.9 МБ — 10 копий одной и той же сборки
    ├── .output/           584 КБ
    ├── #/  и  dev/                — папки-артефакты от опечатки в командах
```

**Метрики:** 4099 строк всего · 1899 строк продакшн-кода · 403 строки тестов · 15 коммитов · 1 ветка.
**Размер сборки:** 263 КБ всего, из них content script 18 КБ ✅ (лимит по ТЗ — 50 КБ gzip).

---

## 2. Сильные стороны (что беречь и не трогать)

### 2.1 Архитектура — реально хорошая

Правило «entrypoints содержат только оркестрацию, вся логика — чистые функции в `shared/`» **соблюдено буквально**. Это редкость. Следствия:

- `field-matcher` и `extractors` тестируются без браузера, в happy-dom, за 25 мс.
- Content script весит 18 КБ — ноль фреймворка, ноль зависимостей.
- Заменить UI-слой (React → Preact/Svelte) можно, не тронув ни строки логики.

### 2.2 Типизированный контракт сообщений

[shared/messages.ts](shared/messages.ts) — discriminated unions на 4 направления (`PopupToContent`, `ContentToPopup`, `ToBackground`, `FromBackground`). Компилятор ловит рассинхрон между отправителем и получателем. Это делают единицы.

### 2.3 `setNativeValue` — правильное решение правильной проблемы

[shared/filler/setNativeValue.ts:7-18](shared/filler/setNativeValue.ts#L7-L18) — запись через нативный сеттер прототипа + bubbling `input`/`change`. Это **единственный** способ заставить React-контролируемые формы принять значение. Автор понимает, как устроен React.

### 2.4 Правильная модель хранения секретов

`sync` (кросс-девайс, ≤100 КБ) — профили и шаблоны. `local` (никогда не синхронизируется) — API-ключи и журнал. Соответствует S-1 из ТЗ. Правильно.

### 2.5 Словарь распознавания вынесен в конфиг

[shared/field-matcher/dictionary.ts](shared/field-matcher/dictionary.ts) — добавить сайт/язык можно без правки движка. Двуязычность EN+CS с fold-ом диакритики ([scorer.ts:9-14](shared/field-matcher/scorer.ts#L9-L14)) — грамотно.

### 2.6 Цепочка фолбэков извлечения вакансии

JSON-LD (+ обход `@graph`) → OpenGraph → эвристики по `h1`/`title`. Порядок правильный, реализация аккуратная.

### 2.7 Единая точка сетевого выхода

Весь `fetch` — только в background ([S-2](TZ_jobfill_extension.md)). Content script в сеть не ходит. Обход CSP страницы, правильная модель безопасности.

### 2.8 Проработанное ТЗ

458 строк с FR/NFR-нумерацией, матрицей тестирования, риск-регистром и оценкой в человеко-днях. Многие коммерческие проекты такого не имеют. Код местами ссылается на пункты ТЗ в комментариях — это дисциплина.

### 2.9 Осознанные ограничения по этике

Нет автосабмита. Нет трогания consent/GDPR-чекбоксов ([fingerprint.ts:126-129](shared/field-matcher/fingerprint.ts#L126-L129)). Нет обхода CAPTCHA. Файловые инпуты только подсвечиваются, никогда не заполняются. Это защищает от бана в сторе.

---

## 3. Проблемы — P0 (блокеры релиза)

### P0-1. CI красный. Три шага из пяти падают

Проверено запуском:

| Шаг CI | Результат |
|---|---|
| `npm run compile` | ❌ **FAIL** — TS2322 в [wxt.config.ts:8](wxt.config.ts#L8) |
| `npm run lint` | ❌ **FAIL** — **11 425 ошибок** |
| `npm run coverage` | ❌ **FAIL** — 26.15% строк при пороге 90% |
| `npm run build` | ✅ PASS (638 мс) |
| `npm run build:firefox` | ✅ PASS |

**Детали:**

1. **Typecheck.** Конфликт версий Vite: `@tailwindcss/vite` тянет vite 7 из корня, WXT использует свой вложенный vite. Типы `Plugin` несовместимы. Лечится через `resolutions`/`overrides` в package.json либо `plugins: [tailwindcss() as any]`.

2. **Lint.** [eslint.config.js:27](eslint.config.js#L27) игнорирует только `.wxt/`, `dist/`, `node_modules/`. Поэтому ESLint линтит **собранные бандлы** в `testForB/` (48 файлов) и `.output/` (10 файлов). Реальных ошибок в исходниках всего **23**:
   - [shared/filler/index.ts:89,97](shared/filler/index.ts#L89) — тернарник как statement (`match.confidence === 'high' ? summary.high++ : summary.medium++`);
   - [scripts/generate-icons.js](scripts/generate-icons.js) — 21 ошибка, CommonJS-файл линтится как ESM-браузерный (нет `globals.node`).

3. **Coverage.** Порог 90/80 выставлен на весь `shared/**`, но покрыты только `field-matcher` (87.87%) и `extractors` (90.9%). `filler`, `storage`, `api` — **0%**.

> На origin висит ветка `copilot/fix-failing-ci-job` — значит проблема известна и не решена.

### P0-2. Функция v5 («журнал заявок») не существует в UI

Backend умеет обрабатывать `LOG_APPLICATION` ([background.ts:34-39](entrypoints/background.ts#L34-L39)), Notion- и Sheets-клиенты написаны, локальное хранилище готово. **Но это сообщение никто никогда не отправляет.** `grep -rn LOG_APPLICATION entrypoints shared` даёт только объявление типа и обработчик.

Следствия: `ApplicationEntry` не создаётся никогда → список «Recent applications» в попапе всегда пуст → FR-6.1 и FR-6.4 не выполнены → README и ТЗ помечают v5 как «✅ shipped» **неверно**.

### P0-3. Нарушен собственный NFR-2: `<all_urls>` + `all_frames`

ТЗ, NFR-2: *«No broad `<all_urls>` host permission; content script injection occurs on user action via activeTab»*.

Факт — [entrypoints/content.ts:21-23](entrypoints/content.ts#L21-L23) и собранный манифест:
```json
"content_scripts":[{"matches":["<all_urls>"],"all_frames":true,"run_at":"document_idle"}]
```

Расширение выполняет код **на каждой странице и в каждом iframe интернета**, включая онлайн-банк, почту и рекламные фреймы. Это:
- прямое противоречие NFR-2 и таблице разрешений в README;
- повод для расширенной проверки/отказа в Chrome Web Store;
- постоянные `focusin`/`scroll`/`resize`-слушатели на каждой вкладке.

Плюс `scripting` в permissions объявлен и **нигде не используется**, а `activeTab` избыточен при статическом content script.

### P0-4. Кнопка «⚡ Fill» появляется рядом с полями паролей

[entrypoints/content.ts:94](entrypoints/content.ts#L94):
```ts
const excluded = ['file','hidden','submit','button','reset','image','checkbox','radio'];
```
`password` в списке **нет**. Тот же пропуск в селекторе перечисления — [fingerprint.ts:117](shared/field-matcher/fingerprint.ts#L117).

Итог: на любой форме логина в интернете рядом с полем пароля всплывает синяя кнопка расширения. Это мгновенно убивает доверие пользователя и является красным флагом при ревью в сторе. Плюс `input[type=password]` попадает в `enumerateFillable()` и участвует в скоринге.

### P0-5. `chrome.tabs.sendMessage` + `all_frames` = ответ приходит не из того фрейма

[popup/App.tsx:58](entrypoints/popup/App.tsx#L58) шлёт `FILL_FORM` без `frameId`. Сообщение уходит **во все фреймы**, но Chrome доставляет попапу **только первый пришедший `sendResponse`**.

На LinkedIn Easy Apply, Greenhouse-эмбедах, Workable — форма живёт в iframe. Верхний фрейм ответит `{high:0, medium:0}` быстрее → пользователь увидит «0 заполнено», хотя поля заполнились. То же касается `EXTRACT_JOB_INFO` и `FILL_ANSWERS`.

**Нужно:** `chrome.webNavigation.getAllFrames` или сбор ответов со всех фреймов с агрегацией, либо выбор фрейма с максимальным числом полей.

### P0-6. Firefox-сборка: `storage.sync` не работает

Собранный `firefox-mv2/manifest.json` не содержит `browser_specific_settings.gecko.id`. В Firefox **`storage.sync` без явного ID расширения не персистится**. То есть на Firefox профили молча не сохраняются между сессиями. README при этом заявляет полную поддержку Firefox.

Бонус: в MV2-манифест утёк permission `scripting`, которого в MV2 не существует → замечание при ревью на AMO.

### P0-7. Google Sheets-логирование сломано на уровне разрешений

[shared/api/sheets.ts:12](shared/api/sheets.ts#L12) использует `redirect: 'follow'`. Apps Script Web App **всегда** редиректит с `script.google.com` на `script.googleusercontent.com`. В `host_permissions` второго домена нет → запрос будет заблокирован. Нужно добавить `https://script.googleusercontent.com/*`.

---

## 4. Проблемы — P1 (качество ядра и данных)

### P1-1. Ложные срабатывания правила `fullName`

[dictionary.ts:44](shared/field-matcher/dictionary.ts#L44): `pattern: /\bfull[.\s_-]?name\b|\bname\b|.../i`

Голое `\bname\b` матчит **любое** поле со словом «name» в label: `Company name`, `Referral name`, `Manager name`, `File name`, `Project name`. Такое поле набирает 25 (semanticName) + 20 (label) = **45 → medium → заполняется ФИО кандидата**.

### P1-2. Правило `city` матчит `location`

[dictionary.ts:79](shared/field-matcher/dictionary.ts#L79): `/\bcity\b|location|.../i`. Поле фильтра «Location» на странице поиска вакансий будет забито городом пользователя.

### P1-3. Скоринг без защиты от «почти-ничьей»

[scorer.ts:70](shared/field-matcher/scorer.ts#L70): `if (score > 0 && (!best || score > best.score))`. Побеждает просто максимум, без проверки отрыва от второго места. Два правила с 45 и 44 очками — победа определяется порядком в массиве. Нужен минимальный margin (например, ≥15) — иначе понижать до `low` и не заполнять.

### P1-4. `getContextHeading` — источник шума

[fingerprint.ts:72-91](shared/field-matcher/fingerprint.ts#L72-L91) поднимается по всем предкам и возвращает текст **любого** предыдущего `div`/`span`/`p` короче 80 символов. На реальных ATS это часто подпись соседнего поля или хлебная крошка → лишние +10 очков случайному правилу. Плюс сложность O(предки × соседи) на каждое поле — риск для NFR-3 (300 мс на 200 контролов).

### P1-5. `aria-labelledby` обрабатывается неверно

[fingerprint.ts:63-67](shared/field-matcher/fingerprint.ts#L63-L67): `getElementById(labelledBy)` для всей строки. По спецификации это **список ID через пробел**. Для `aria-labelledby="lbl1 lbl2"` вернётся `null` — типичный паттерн на Workday и Greenhouse теряется.

### P1-6. Детект открытых вопросов слишком узкий

[scorer.ts:78-85](shared/field-matcher/scorer.ts#L78-L85) требует `<textarea>` **и** `labelText.length > 20` **и** вопросительный префикс. Большинство ATS кладут текст вопроса не в `<label>`, а в соседний `<div>` или `aria-label`. Фича будет молчать на большинстве реальных форм.

### P1-7. `importSyncData` пишет непроверенный JSON прямо в storage

[storage/sync.ts:93-110](shared/storage/sync.ts#L93-L110) валидирует ровно одно поле — `schemaVersion === 1` — и делает `chrome.storage.sync.set({[KEY]: parsed})`. Файл с `profiles: "строка"` сломает и попап, и опции без возможности восстановления через UI. Нужна схемная валидация (zod / valibot / arktype) и миграции по `schemaVersion`.

### P1-8. Read-modify-write без блокировок

[storage/sync.ts:11-14](shared/storage/sync.ts#L11-L14): `setSyncData` читает всё, мержит, пишет всё. Если попап и опции пишут одновременно — одно из изменений теряется. Нужны точечные ключи или очередь записи.

### P1-9. Нет ретрая для удалённого логирования

FR-6.3 требует «одну повторную попытку». [background.ts:94-113](entrypoints/background.ts#L94-L113) при ошибке сразу ставит `failed`. Статус `pending` из типа `ApplicationEntry` не используется вообще.

### P1-10. Мёртвый код

| Символ | Где | Статус |
|---|---|---|
| `API_ERROR_MESSAGES` | [messages.ts:55](shared/messages.ts#L55) | не используется нигде |
| `getStorageUsagePercent` | [storage/sync.ts:78](shared/storage/sync.ts#L78) | не вызывается → **FR-1.2 (предупреждение при 80% квоты) не выполнен** |
| `upsertProfile`, `deleteProfile` | [storage/sync.ts:39,50](shared/storage/sync.ts#L39) | UI пишет массив целиком, минуя их |
| `serializeFingerprint` | [fingerprint.ts:110](shared/field-matcher/fingerprint.ts#L110) | не вызывается |
| `removeAllHighlights`, `removeStyles` | [highlight.ts:73,82](shared/filler/highlight.ts#L73) | только реэкспорт, не вызываются |
| `CLASSIFY_FIELDS` | [background.ts:27](entrypoints/background.ts#L27) | обработчик есть, отправителя нет → **FR-5.3 не подключён** |

### P1-11. Тестовые фикстуры — синтетические, а не захваченные

ТЗ §8 требует «captured HTML form fragments per site». Реально это 4 рукописных файла по 52–58 строк с идеальными `<label for>` и чистыми `name`. Реальный Greenhouse/Workday — это `<div>`-комбобоксы, обфусцированные атрибуты и shadow DOM. **Тесты проверяют идеальный мир, а не тот, в котором расширение будет работать.**

### P1-12. `FILL_COVER_TEXT` целится наугад

[content.ts:49-66](entrypoints/content.ts#L49-L66): цель = `document.activeElement` → подсвеченная textarea → **первая `<textarea>` на странице**. Но открытие попапа снимает фокус со страницы, а первая textarea может быть поиском или чатом. Текст мотивационного письма улетит не туда.

### P1-13. Notion-схема захардкожена

[api/notion.ts:20-27](shared/api/notion.ts#L20-L27) требует ровно свойства `Name / Company / URL / Date / Status / Profile` нужных типов. Любая другая база → ошибка 400 с текстом от Notion. Нет ни discovery схемы, ни маппинга, ни инструкции в UI.

---

## 5. ДИЗАЙН — детальный разбор (проверено рендером)

Собранная сборка была отрендерена в headless Chrome со стабом `chrome.*` API и реальными демо-данными. Ниже — измеренные факты, не мнения.

### 5.1 🔴 Страница настроек: app-shell layout сломан

**Измерено при вьюпорте 1265 × 633:**
```
высота корневого контейнера = 1030.75 px
высота вьюпорта             =  633 px
```

[options/App.tsx:47](entrypoints/options/App.tsx#L47) использует `min-h-screen` вместо `h-screen`. Дальше [строка 62](entrypoints/options/App.tsx#L62) — `flex flex-1 overflow-hidden`, а [строка 91](entrypoints/options/App.tsx#L91) — `main` с `overflow-y-auto`.

**Почему ломается:** `min-h-screen` задаёт только *минимальную* высоту. У flex-элементов `min-height: auto`, поэтому строка-контейнер разрастается под содержимое до 1031 px. В результате:

- `overflow-y-auto` у `<main>` **никогда не срабатывает** — это мёртвый CSS;
- скроллится **вся страница целиком**, а не только контентная область;
- шапка (`shrink-0`, но не `sticky`) **уезжает вверх** при скролле;
- сайдбар с навигацией **уезжает вместе с ней** — на длинной форме профиля переключателя вкладок на экране нет;
- ручка ресайза сайдбара тянется только на высоту контента, а не окна.

**Фикс:** `h-screen` + `overflow-hidden` на корне; шапка `shrink-0`; сайдбар `h-full overflow-y-auto`; `<main>` — единственный скролл-контейнер.

### 5.2 🔴 Поля формы растянуты на всю ширину — 1076 px

В коде дважды стоит комментарий `{/* no max-width — use full available space */}` ([строки 145](entrypoints/options/App.tsx#L145) и [281](entrypoints/options/App.tsx#L281)). Результат при окне 1280:

| Элемент | Измеренная ширина |
|---|---|
| Поле «Profile label» | **1076 px** |
| Поле «First name» | **525 px** |
| Поле «Template name» | **1076 px** |
| Textarea тела шаблона | **1076 × 280 px** |

Инпут под имя профиля шириной в метр — это не «использование пространства», это отсутствие меры. Комфортная длина строки — 45–75 символов (~640 px при 16px). Textarea шаблона моноширинным шрифтом на 1076 px даёт ~180 символов в строке — читать невозможно.

**Фикс:** контентный контейнер `max-w-[900px]`, поля в сетке `minmax(280px, 1fr)`, textarea `max-w-[70ch]`.

### 5.3 🔴 Вкладки имеют разную ширину контента

- `ProfilesTab` — без ограничения (1076 px)
- `TemplatesTab` — без ограничения (1076 px)
- `ApiTab` — [`max-w-lg`](entrypoints/options/App.tsx#L388) = **512 px**

При переключении вкладок макет прыгает: то во весь экран, то узкая колонка слева с 560 px пустоты справа (видно на рендере вкладки «API & Logging»). Это самый заметный визуальный дефект.

### 5.4 🔴 Контрастность не проходит WCAG AA

Расчёт по WCAG 2.1 для текущей палитры:

| Цвет | Фон | Контраст | AA (4.5:1) | Где применяется |
|---|---|---|---|---|
| `#cccccc` | `#1e1e1e` | 10.38 | ✅ | основной текст |
| `#e8e8e8` | `#252526` | 12.50 | ✅ | заголовки |
| `#767676` | `#1e1e1e` | **3.67** | ❌ | `.label`, `.section-desc` — **все подписи полей** |
| `#767676` | `#252526` | **3.37** | ❌ | подписи в шапке |
| `#858585` | `#252526` | **4.15** | ❌ | неактивные пункты сайдбара |
| `#585858` | `#1e1e1e` | **2.34** | ❌❌ | футер, подписи в сводке |
| `#585858` | `#3c3c3c` | **1.55** | ❌❌ | **placeholder внутри инпутов — почти невидим** |
| `#777777` | `#3c3c3c` | **2.46** | ❌❌ | **граница фокуса** |

Семь из четырнадцати пар не проходят. Три из них не проходят даже порог для крупного текста (3:1). При этом `.label` — это `text-[11px] uppercase tracking-widest`: мелкий разреженный шрифт при контрасте 3.67 читается плохо даже для зрячего пользователя без нарушений.

### 5.5 🔴 Фокус клавиатуры практически невидим

[globals.css:26-29](assets/styles/globals.css#L26-L29):
```css
.input { ... focus:outline-none focus:border-[#777] focus:bg-[#444] ... }
```

`outline-none` убирает системный индикатор фокуса, а замена — рамка `#777` на фоне `#3c3c3c` с контрастом **2.46:1** (норма WCAG 2.4.11 — 3:1). На рендере со сфокусированным полем разница с обычным состоянием почти не различима.

Это прямое нарушение **NFR-7 собственного ТЗ**: *«Popup and options pages SHALL be keyboard-navigable with visible focus states»*.

**Фикс:** `focus-visible:outline-2 outline-offset-2 outline-[#4da3ff]` (контраст ≥3:1 к обоим фонам).

### 5.6 🟠 Попап мигает «No profiles yet» при каждом открытии

[popup/App.tsx:104](entrypoints/popup/App.tsx#L104):
```tsx
if (profiles.length === 0) { return <пустое состояние с кнопкой "Open Settings" /> }
```
Начальное состояние — `useState([])`, а `chrome.storage` асинхронный. Значит **первый кадр каждого открытия попапа** — это экран «Профилей нет». Затем он подменяется реальным UI. Пользователь видит вспышку неверного сообщения при каждом клике по иконке.

**Фикс:** третье состояние `loading` + скелетон фиксированной высоты.

### 5.7 🟠 Скролл в попапе — мёртвый код

[popup/App.tsx:117](entrypoints/popup/App.tsx#L117) — корень `flex flex-col overflow-hidden` без заданной высоты, [строка 151](entrypoints/popup/App.tsx#L151) — `flex-1 overflow-y-auto`. Та же ошибка, что в §5.1: без фиксированной высоты у родителя `flex-1` не ограничивает ребёнка и `overflow-y-auto` не активируется.

Пока контент помещается в 600 px (лимит попапа Chrome) — незаметно. С развёрнутым списком заявок + сгенерированным текстом мотивации попап упрётся в лимит и контент обрежется вместо прокрутки.

**Фикс:** `h-[600px]` (или `max-h-[600px]` + `h-auto`) на корне попапа.

### 5.8 🟠 Магические числа вместо системы

- `h-[214px]` в пустом состоянии попапа ([строка 106](entrypoints/popup/App.tsx#L106)) — откуда 214?
- `w-[380px]`, `max-h-36`, `h-28`, `sidebarWidth = 160`, `width: 1280, height: 720`
- 16 разных хардкод-хексов по всему коду: `#1e1e1e #252526 #2d2d2d #37373d #3c3c3c #3e3e42 #505050 #585858 #767676 #777 #858585 #aaa #cccccc #e8e8e8 #0e639c #1177bb`
- Размеры шрифта: `text-[10px] text-[11px] text-[12px] text-[13px] text-[15px] text-xs text-sm text-base` — смешаны две шкалы

**Нет ни одного CSS-переменной, ни одного токена.** Tailwind v4 позволяет объявить тему через `@theme` — это не используется вообще. Отсюда и метания в истории коммитов:

```
d8baa02 feat: popup 16:9 ratio (640×360px)
17bde79 fix: options page full-width layout, popup back to 380px
76878af fix: wider layout, lighter dark theme (#1e1e1e), author credit
c625222 feat: resizable sidebar in options page
ffa1beb feat: open settings as 1280x720 (16:9) popup window
```
Пять коммитов подряд, переигрывающих размеры туда-обратно. Это классический симптом отсутствия дизайн-системы: каждое изменение — точечный подбор числа, а не применение правила.

### 5.9 🟠 Страница настроек открывается двумя разными способами

- Из попапа — [`chrome.windows.create({type:'popup', width:1280, height:720})`](entrypoints/popup/App.tsx#L10)
- Из `chrome://extensions` → «Параметры» — встроенный диалог

При этом [wxt.config.ts:29](wxt.config.ts#L29) задаёт `open_in_tab: true`, но **в собранном манифесте этого флага нет**:
```json
"options_ui":{"page":"options.html"}
```
WXT переопределяет `options_ui` из entrypoint-а, игнорируя `manifest.options_ui` в конфиге (нужен `<meta name="manifest.open_in_tab" content="true">` в `options/index.html`). Рендер во встроенном диалоге ~600×400 показывает: сайдбар съедает 160 из 600 px, контент 420 px, двухколоночная сетка сжимается до 190 px на поле.

Кроме того, `windows.create` задаёт **внешний** размер окна — с учётом рамки и заголовка вьюпорт получается 1265 × 633, а не 1280 × 720. Заявленное «16:9» им не является.

### 5.10 🟡 Мелочи, портящие впечатление

| Что | Где | Проблема |
|---|---|---|
| `⚙` текстовым глифом | [popup/App.tsx:137](entrypoints/popup/App.tsx#L137) | рендерится по-разному в macOS/Windows/Linux; кликабельная зона ~16 px при норме 24 px |
| `⚡` в кнопке и тостах | [inlineButton.ts:72](shared/filler/inlineButton.ts#L72) | эмодзи вместо иконки |
| Ссылка на Instagram | [popup:235](entrypoints/popup/App.tsx#L235), [options:52](entrypoints/options/App.tsx#L52) | личный соцаккаунт в продуктовом UI — при ревью в сторе смотрится непрофессионально |
| Нативный `<select>` профилей | [popup/App.tsx:123](entrypoints/popup/App.tsx#L123) | системная стрелка выбивается из тёмной темы |
| `confirm()` / `alert()` | [options:122,140](entrypoints/options/App.tsx#L122) | системные модалки вместо UI-компонентов |
| `color-scheme: dark` жёстко | [globals.css:7](assets/styles/globals.css#L7) | нет светлой темы и нет `prefers-color-scheme` |
| Нет пустых состояний | Templates, Recent applications | при отсутствии данных просто ничего не отрисовано |
| Ручка ресайза без клавиатуры | [options/App.tsx:84-88](entrypoints/options/App.tsx#L84-L88) | `onMouseDown` без `role="separator"`, `tabIndex`, стрелок; не работает на тач-устройствах; ширина не сохраняется между сессиями |
| Разнобой отступов | popup | `p-4`, `px-4 py-3`, `px-4 py-2.5`, `px-4 py-2` в соседних секциях |

---

## 6. Соответствие ТЗ — матрица

| Требование | Статус | Комментарий |
|---|---|---|
| FR-1.1 Профиль со всеми полями | ✅ | все 13 полей есть |
| FR-1.2 Предупреждение при 80% квоты sync | ❌ | `getStorageUsagePercent` написан, но не вызывается |
| FR-1.3 Мультипрофили + предвыбор последнего | ✅ | |
| FR-1.4 Экспорт/импорт с валидацией | ⚠️ | валидируется только `schemaVersion` |
| FR-2.1 Перечисление контролов, iframes | ⚠️ | работает, но `password` не исключён |
| FR-2.2 Fingerprint из 7 источников | ✅ | |
| FR-2.3 Двуязычный словарь в конфиге | ✅ | |
| FR-2.4 Уровни уверенности и пороги | ⚠️ | нет проверки отрыва от второго места |
| FR-2.5 Файловые инпуты только подсветка | ✅ | |
| FR-2.6 Consent-контролы не трогать | ✅ | |
| FR-3.1 Native setter + события | ✅ | эталонно |
| FR-3.3 Стратегия для `<select>` | ✅ | |
| FR-3.4 Сводка в попапе | ✅ | |
| FR-3.5 Автоснятие подсветки | ✅ | |
| FR-4.1–4.2 Шаблоны + извлечение вакансии | ✅ | |
| FR-4.3 Подсветка «review» для шаблона | ❌ | вставляется как обычное поле |
| FR-5.1 Ключ Groq в local | ✅ | |
| FR-5.2 Генерация мотивации | ✅ | |
| FR-5.3 LLM-классификация полей | ❌ | обработчик есть, вызова нет |
| FR-5.4 Различимые ошибки API | ⚠️ | типы есть, `API_ERROR_MESSAGES` не используется |
| FR-6.1 Создание записи журнала | ❌ | **нет пути в коде** |
| FR-6.2 Notion / Sheets | ⚠️ | клиенты есть, Sheets сломан редиректом |
| FR-6.3 Локальная копия + 1 ретрай | ❌ | ретрая нет |
| FR-6.4 10 последних в попапе | ❌ | всегда пусто (см. FR-6.1) |
| NFR-2 Минимум разрешений | ❌ | `<all_urls>` + неиспользуемый `scripting` |
| NFR-3 ≤300 мс, ≤50 КБ content script | ⚠️ | 18 КБ ✅, скорость не измерялась |
| NFR-4 Изоляция страницы | ⚠️ | `removeStyles`/`removeAllHighlights` не вызываются |
| NFR-6 Архитектура под `_locales` | ❌ | `_locales` нет, все строки захардкожены |
| NFR-7 Доступность | ❌ | см. §5.4, §5.5 |

**Итого: 13 ✅ · 7 ⚠️ · 10 ❌**

---

## 7. Что улучшить — предложения

### 7.1 Стек: оставить основу, точечно усилить

| Слой | Сейчас | Предложение | Зачем |
|---|---|---|---|
| Фреймворк расширения | WXT 0.21 | **оставить** | лучший выбор для MV3 + Firefox из одной кодовой базы |
| Язык | TypeScript strict | **оставить** | |
| UI попапа | React 19 (195 КБ чанк) | **Preact + `preact/compat`** через alias | попап должен открываться мгновенно; ~3 КБ вместо 195 КБ, JSX и код не меняются |
| UI настроек | React 19 | **оставить React** | тяжёлая форма, скорость открытия не критична |
| Стили | Tailwind v4, хардкод-хексы | **Tailwind v4 + `@theme` токены** | одна правка темы вместо 16 хексов по файлам |
| Компоненты | самописные | **Radix UI primitives** (select, dialog, tabs, tooltip) | доступность и клавиатура из коробки, ~10 КБ |
| Валидация данных | нет | **valibot** (~2 КБ) | схемы для импорта, ответов Groq, миграций storage |
| Storage | сырые обёртки | **`wxt/storage`** (`defineItem`) | реактивность, версии, миграции, дефолты — уже в WXT |
| API расширений | глобальный `chrome` | **`browser` из `wxt/browser`** | корректная работа на Firefox |
| Тесты | Vitest + happy-dom | **+ `@webext-core/fake-browser`, + Playwright** | покрыть storage/filler/api и E2E-сценарии |
| Иконки | эмодзи + глифы | **lucide-react** (tree-shaken) | консистентность на всех ОС |
| AI | Groq (Llama 3.3 70B) | **оставить + добавить провайдеров** | Groq быстрый и дешёвый; абстракция провайдера снимет lock-in |

### 7.2 Дизайн-система — конкретно

Ввести в `globals.css` через Tailwind v4 `@theme`:

```css
@theme {
  /* Поверхности */
  --color-surface-base: #17181c;   /* фон страницы */
  --color-surface-raised: #1f2126; /* шапка, сайдбар, карточки */
  --color-surface-input: #2a2d34;
  --color-surface-hover: #2f333b;

  /* Границы */
  --color-border-subtle: #33373f;
  --color-border-strong: #4a4f59;

  /* Текст — все пары ≥4.5:1 к своей поверхности */
  --color-text-primary: #e6e8ec;   /* 13.2:1 */
  --color-text-secondary: #a8aeb8; /*  7.1:1 — вместо #767676 */
  --color-text-muted: #8b929d;     /*  5.2:1 — вместо #585858 */

  /* Акценты */
  --color-accent: #3b82f6;
  --color-accent-hover: #2563eb;
  --color-focus: #60a5fa;          /* ≥3:1 к любой поверхности */

  /* Семантика уверенности — единые для попапа и подсветки на странице */
  --color-confidence-high: #34d399;
  --color-confidence-medium: #fbbf24;
  --color-confidence-none: #6b7280;
  --color-confidence-ai: #a78bfa;
  --color-confidence-file: #60a5fa;

  /* Шкала отступов и радиусов — 4px база */
  --spacing-unit: 0.25rem;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;

  /* Типографика — одна шкала, никаких text-[13px] */
  --text-xs: 11px; --text-sm: 12px; --text-base: 13px;
  --text-lg: 15px; --text-xl: 18px;
}
```

Правила, которые нужно зафиксировать письменно и соблюдать:
1. **Ни одного хекса в JSX** — только токены.
2. **Ни одного `[N px]`-размера в компонентах** — только шкала.
3. **`focus-visible` обязателен** для каждого интерактивного элемента, контраст ≥3:1.
4. **Контентная колонка ≤ 900 px**, поля в `minmax(280px, 1fr)`.
5. **Один скролл-контейнер на страницу** — `h-screen` на корне, `overflow-y-auto` только на `<main>`.
6. **Три состояния у каждого экрана**: loading (скелетон) / empty (иллюстрация + CTA) / error.

### 7.3 Продуктовые улучшения (сверх ТЗ)

**Точность распознавания — главный дифференциатор продукта.** Всё остальное вторично.

1. **Профили сайтов.** Словарь селекторов под конкретные ATS (Greenhouse, Lever, Workable, Workday, SmartRecruiters, Jobs.cz, StartupJobs) — точное совпадение вместо эвристики там, где разметка известна. Хранить как JSON, обновлять без релиза расширения.
2. **`<div>`-комбобоксы.** Workday и Greenhouse используют кастомные дропдауны — сейчас это 100% промах. Нужна стратегия: клик → поиск опции в поповере → клик по опции.
3. **Обучение на исправлениях.** Если пользователь после автозаполнения поменял значение — запомнить связку fingerprint→поле для этого домена. За месяц использования точность вырастет заметнее, чем от любой правки словаря.
4. **Резюме → профиль (v6 из ТЗ).** PDF.js в Web Worker, полностью локально. Это устраняет главный барьер входа: 13 полей руками при первом запуске.
5. **Горячая клавиша.** `commands` в манифесте, `Alt+Shift+F` — заполнить активной формой. Инструмент такого класса обязан работать без мыши.
6. **Предпросмотр перед вставкой.** Панель «будет заполнено 12 полей» с возможностью снять галочки — снимает страх «а вдруг оно напишет ерунду в форму, которую я отправляю работодателю».
7. **Логирование заявок — довести до конца.** После заполнения показать кнопку «Записать заявку» → создать `ApplicationEntry` → отправить `LOG_APPLICATION`. Это 30 строк кода, которые превращают заявленную, но несуществующую фичу v5 в реальную.
8. **i18n.** `_locales` для EN / CS / RU. Аудитория расширения — Чехия, интерфейс только на английском.

### 7.4 Инфраструктура

- Починить typecheck (`overrides` для vite), lint (`ignores` + `globals.node` для `scripts/`), coverage (пороги по директориям).
- Удалить `testForB/` (2.9 МБ), `#/`, `dev/`.
- Добавить `browser_specific_settings.gecko.id` для Firefox.
- Добавить `https://script.googleusercontent.com/*` в host_permissions.
- E2E-тесты на Playwright с реально загруженным расширением: попап открывается, заполнение работает на локальной тестовой форме.
- Скрипт захвата реальных фикстур с боевых ATS-страниц вместо рукописных.
- `_locales` + `default_locale` в манифесте.
- Хостинг privacy policy (GitHub Pages) — для Web Store нужен URL, а не файл в репозитории.

---

## 8. План работ, разбитый на независимые потоки

Разбиение сделано так, чтобы потоки **не пересекались по файлам** — их можно вести параллельно.

### Поток A — «Инфраструктура и CI» 🔴 блокер
`package.json` · `eslint.config.js` · `vitest.config.ts` · `wxt.config.ts` · `.gitignore` · `.github/`
- Починить `npm run compile` (конфликт vite)
- Починить `npm run lint` (ignores + node globals) — 11 425 → 0
- Пороги coverage по директориям вместо глобальных
- Удалить `testForB/`, `#/`, `dev/`
- `browser_specific_settings.gecko.id`, `script.googleusercontent.com`, `commands`, `default_locale`

### Поток B — «Безопасность и разрешения» 🔴 блокер
`entrypoints/content.ts` · `wxt.config.ts` · `shared/field-matcher/fingerprint.ts`
- Исключить `input[type=password]` из `isFillable` и `enumerateFillable`
- Уйти от `<all_urls>` к `activeTab` + программной инъекции (`chrome.scripting.executeScript`)
- Решить вопрос `all_frames` и адресации фреймов (`frameId`)
- Вызывать `removeStyles`/`removeAllHighlights` при выгрузке

### Поток C — «Дизайн-система и layout» 🔴 блокер
`assets/styles/globals.css` · `entrypoints/options/App.tsx` · `entrypoints/popup/App.tsx`
- Токены через `@theme`, вычистить все хардкод-хексы
- `h-screen` + один скролл-контейнер (§5.1, §5.7)
- `max-w` на контентную колонку, единая ширина всех вкладок (§5.2, §5.3)
- Палитра с контрастом ≥4.5:1 (§5.4)
- Видимый `focus-visible` (§5.5)
- Состояния loading / empty / error (§5.6)
- Заменить эмодзи и `⚙` на lucide-иконки
- Ручка ресайза: `role="separator"` + клавиатура + сохранение ширины

### Поток D — «Точность движка распознавания» 🟠
`shared/field-matcher/**` · `tests/field-matcher.test.ts`
- Ужесточить `fullName` и `city` (P1-1, P1-2)
- Margin-проверка в скорере (P1-3)
- Переписать `getContextHeading` (P1-4)
- Поддержать список ID в `aria-labelledby` (P1-5)
- Расширить детект открытых вопросов (P1-6)
- Захватить реальные фикстуры с 4+ ATS и покрыть тестами

### Поток E — «Довести v5: журнал заявок» 🟠
`entrypoints/popup/App.tsx` (секция логирования) · `entrypoints/background.ts` · `shared/api/notion.ts`
- Кнопка «Записать заявку» → `ApplicationEntry` → `LOG_APPLICATION`
- Ретрай + состояние `pending` (FR-6.3)
- Discovery схемы Notion + инструкция в UI
- Починить редирект Apps Script

### Поток F — «Надёжность хранилища» 🟠
`shared/storage/**` · `shared/types.ts`
- Схемная валидация импорта (valibot) + миграции по `schemaVersion`
- Убрать read-modify-write гонку
- Подключить `getStorageUsagePercent` в UI (FR-1.2)
- Рассмотреть переход на `wxt/storage`

### Поток G — «Тесты» 🟡
`tests/**`
- Покрыть `filler`, `storage`, `api` (сейчас 0%)
- `@webext-core/fake-browser` для storage-тестов
- Playwright E2E с загруженным расширением

### Поток H — «Документация» 🟡
`README.md` · `TZ_jobfill_extension.md` · `privacy-policy.md`
- Привести статусы v1–v5 в соответствие с реальностью
- Исправить `firefox-mv3` → `firefox-mv2`
- Актуализировать таблицу разрешений
- Захостить privacy policy

**Порядок:** A, B, C — параллельно и первыми (блокеры). D, E, F — вторая волна. G, H — по мере готовности остальных.

---

## 9. Итог

Проект написан человеком, который **понимает архитектуру**: разделение слоёв, чистые функции, типизированные контракты, native-setter для React-форм, единая точка сетевого выхода — всё это сделано правильно и осознанно. ТЗ на 458 строк с FR/NFR-нумерацией — уровень, до которого не дотягивают многие коммерческие команды.

Провалы лежат в трёх областях, и все три — исправимые:

1. **Дисциплина завершения.** Написаны клиенты Notion и Sheets, обработчик `LOG_APPLICATION`, локальное хранилище журнала — но не написаны 30 строк, которые всё это соединяют. То же с `CLASSIFY_FIELDS` и `getStorageUsagePercent`. Фича считается сделанной, когда до неё можно дойти из UI.

2. **Дизайн без системы.** Пять коммитов подряд переигрывают размеры окна туда-обратно, потому что нет ни одного токена и ни одного правила — каждый раз подбирается число. Отсюда и сломанный layout, и провал по контрасту, и невидимый фокус.

3. **Разрыв между ТЗ и манифестом.** NFR-2 запрещает `<all_urls>` — в манифесте `<all_urls>`. NFR-7 требует видимый фокус — фокус невидим. ТЗ хорошее, но оно не проверяется автоматически, поэтому расходится с кодом.

CI при этом красный, и это делает все три пункта неизбежными: пока `compile`, `lint` и `coverage` падают, ничто не мешает расхождению расти дальше.

**Оценка объёма:** блокеры (потоки A, B, C) — 3–4 дня. Полная доводка до состояния «можно подавать в Chrome Web Store» — 8–10 дней.
