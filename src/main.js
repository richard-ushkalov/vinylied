/**
 * Точка сборки. Здесь — и только здесь — ищутся элементы страницы,
 * создаются объекты и связываются их события. Сами классы про DOM
 * снаружи себя не знают: всё нужное получают в конструкторе.
 */
import { ACOUSTID_KEY } from './config.js';
import { FrameLoop } from './core/FrameLoop.js';
import { Settings } from './core/Settings.js';
import { tracksLabel } from './core/format.js';
import { platform } from './core/platform.js';
import { Player } from './audio/Player.js';
import { Database } from './library/Database.js';
import { Inbox } from './library/Inbox.js';
import { Library } from './library/Library.js';
import { Track } from './library/Track.js';
import { TagReader } from './media/TagReader.js';
import { AcoustIdClient } from './lookup/AcoustIdClient.js';
import { CoverArtArchive } from './lookup/CoverArtArchive.js';
import { Fingerprinter } from './lookup/Fingerprinter.js';
import { ITunesClient } from './lookup/ITunesClient.js';
import { LookupQueue } from './lookup/LookupQueue.js';
import { MetadataResolver } from './lookup/MetadataResolver.js';
import { DiscSpinner } from './playback/DiscSpinner.js';
import { MediaSessionBridge } from './playback/MediaSessionBridge.js';
import { PlaybackController } from './playback/PlaybackController.js';
import { Queue } from './playback/Queue.js';
import { ResumeStore } from './playback/ResumeStore.js';
import { LocalSource } from './playback/sources/LocalSource.js';
import { InstallPrompt } from './pwa/InstallPrompt.js';
import { registerServiceWorker } from './pwa/registerServiceWorker.js';
import { Dock } from './ui/Dock.js';
import { EmptyState } from './ui/EmptyState.js';
import { FilePicker } from './ui/FilePicker.js';
import { Hotkeys } from './ui/Hotkeys.js';
import { LibrarySheet } from './ui/LibrarySheet.js';
import { ProgressBar } from './ui/ProgressBar.js';
import { SettingsSheet } from './ui/SettingsSheet.js';
import { StatusLine } from './ui/StatusLine.js';
import { Theme } from './ui/Theme.js';
import { Shelf } from './ui/shelf/Shelf.js';
import { ShelfScroller } from './ui/shelf/ShelfScroller.js';

/**
 * @template {Element} T
 * @param {string} selector
 * @returns {T}
 */
const $ = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`В разметке нет ${selector}`);
    return /** @type {T} */ (element);
};

// ── данные и настройки ─────────────────────────────────────────
const settings = new Settings();
const theme = new Theme({ settings });
theme.attach();
Track.colors = theme.coverColors();

const library = new Library({ db: new Database(), reader: new TagReader() });
/** @type {Map<string, Track>} */
const tracks = new Map();
const inbox = new Inbox();

// ── звук и воспроизведение ─────────────────────────────────────
const player = new Player({ settings, platform });
const local = new LocalSource({ player, tracks });
const queue = new Queue({ order: settings.get('order'), repeat: settings.get('repeat') });
const controller = new PlaybackController({ sources: [local], queue, settings });
const session = new MediaSessionBridge({ controller });
const resume = new ResumeStore();

// ── поиск обложек и названий ───────────────────────────────────
const acoustId = new AcoustIdClient({ key: ACOUSTID_KEY });
const resolver = new MetadataResolver({
    acoustId,
    fingerprinter: new Fingerprinter(),
    itunes: new ITunesClient(),
    coverArt: new CoverArtArchive(),
});
const lookup = new LookupQueue({ library, resolver, settings });

// ── интерфейс ──────────────────────────────────────────────────
const status = new StatusLine($('.status'));
const scroller = new ShelfScroller({
    viewport: $('.scene'),
    probe: $('.shelf-probe'),
    // прокрутка = перемотка, поэтому прикрываем фильтр, как на пульте
    onScrub: amount => controller.scrub(amount),
});
const shelf = new Shelf({
    list: $('.list'),
    scene: $('.scene'),
    template: $('#vinyl-template'),
    scroller,
    reducedMotion: () => theme.reducedMotion,
});
const dock = new Dock($('.dock'));
const progress = new ProgressBar({ root: $('.progress'), controller });
const empty = new EmptyState($('.empty'));
const picker = new FilePicker({ input: $('.file-input'), target: document.body });
const install = new InstallPrompt({ platform });
const librarySheet = new LibrarySheet({
    dialog: $('#library-sheet'),
    library, tracks, settings, lookup, install, controller,
    canFingerprint: () => resolver.canFingerprint,
});
const settingsSheet = new SettingsSheet({ dialog: $('#settings-sheet'), settings, player, platform });
const spinner = new DiscSpinner({
    speed: () => controller.speed(),
    disc: () => shelf.discOf(controller.current),
    still: () => theme.reducedMotion,
});
const frames = new FrameLoop(() => controller.speed() > 0);
frames.add(progress.tick);
frames.add(spinner.tick);

// ── связи ──────────────────────────────────────────────────────
settings.watch(['edgeBlur', 'motionBlur', 'fisheye', 'haptics'], values => scroller.configure(values));
scroller.configure({ reduced: theme.reducedMotion });
theme.on('motion', ({ reduced }) => scroller.configure({ reduced }));
theme.on('theme', () => {
    Track.colors = theme.coverColors();
    for (const track of tracks.values()) {
        if (track.refreshGenerated()) shelf.update(track, { animate: false });
    }
    dock.setTrack(controller.track);
});

/** Мини-обложка — когда играющий конверт вне кадра или отсеян поиском. */
const syncDockCover = () => {
    const id = controller.current;
    dock.setCoverShown(Boolean(id) && !shelf.isOnScreen(/** @type {string} */ (id)));
};
scroller.on('move', syncDockCover);

// Пока идёт запуск, состояние восстанавливается, а не меняется: конверт
// «продолжить с места» должен сразу стоять по центру, без анимаций.
let booting = true;

controller.on('change', ({ current, previous, intent, trackChanged }) => {
    // ручная смена трека: полоса плавно отматывается к началу
    if (trackChanged) progress.rewind();
    shelf.setCurrent(current, previous, { instant: booting });
    dock.setTrack(controller.track);
    dock.setPlaying(intent === 'playing');
    if (trackChanged && current) shelf.follow(current, { instant: booting });
    syncDockCover();
    frames.once();
});
controller.on('ended', () => progress.wrap());
controller.on('seek', () => { frames.once(); frames.start(); });
controller.on('error', ({ id }) => {
    status.show(`Не удалось воспроизвести «${tracks.get(id)?.title ?? 'трек'}»`);
});

// звук реально пошёл — вот теперь эта пластинка наша
local.on('playing', () => { spinner.grab(); frames.start(); });
// на паузе кадры НЕ гасим: цикл догорит сам, когда диск остановится
local.on('pause', () => frames.start());
local.on('emptied', () => spinner.release());

shelf.on('activate', ({ id }) => controller.toggle(id));
shelf.on('filter', ({ visible }) => { controller.setVisible(visible); syncDockCover(); });

dock.on('toggle', () => controller.toggle(controller.current ?? shelf.focusedId()));
dock.on('add', () => picker.open());
dock.on('search', ({ query }) => shelf.filter(query));
dock.on('reveal', () => {
    const id = controller.current;
    if (!id) return;
    if (shelf.isFiltered(id)) dock.closeSearch();
    shelf.follow(id);
});

empty.on('add', () => picker.open());
picker.on('files', ({ files }) => importFiles(files));

librarySheet.on('add', () => picker.open());
librarySheet.on('settings', () => settingsSheet.open());
librarySheet.on('install', () => install.prompt());
librarySheet.on('recheck', () => lookup.recheckAll());
librarySheet.on('remove', ({ id }) => library.remove(id));
librarySheet.on('clear', () => library.clear());

lookup.on('found', ({ id }) => {
    const track = tracks.get(id);
    if (track) status.show(`Нашёл обложку: ${track.title}`);
});

// ── библиотека → полка ─────────────────────────────────────────
library.on('added', ({ record }) => {
    const track = new Track(record);
    tracks.set(track.id, track);
    shelf.add([track]);
    empty.toggle(false);
});
library.on('updated', ({ record }) => {
    const track = tracks.get(record.id);
    if (!track) return;
    const before = `${track.title}|${track.artist}|${track.album}|${track.cover}`;
    track.update(record);
    // проверка метаданных пишет в запись и «не нашли» — конверт трогаем,
    // только если на нём правда что-то поменялось
    if (before === `${track.title}|${track.artist}|${track.album}|${track.cover}`) return;
    shelf.update(track);
    if (track.id === controller.current) {
        dock.setTrack(track);
        session.refresh();
    }
});
library.on('removed', ({ id }) => {
    controller.forget(id);
    tracks.get(id)?.dispose();
    tracks.delete(id);
    shelf.remove(id);
    empty.toggle(!tracks.size);
});
library.on('cleared', () => {
    controller.stop();
    for (const track of tracks.values()) track.dispose();
    tracks.clear();
    shelf.clear();
    empty.toggle(true);
});
library.on('progress', ({ done, total, name }) => {
    status.show(`Добавляю ${done + 1} из ${total}: ${name}`, { sticky: true });
});
library.on('import-end', ({ added, skipped, failed, quota }) => {
    const parts = [];
    if (added) parts.push(`Добавлено: ${tracksLabel(added)}`);
    if (skipped) parts.push(`уже на полке или не музыка: ${skipped}`);
    if (failed) parts.push(`не удалось: ${failed}`);
    if (quota) parts.push('не хватило места на устройстве');
    status.show(parts.join(', ') || 'Нечего добавлять');
});

/** @param {File[]} files */
const importFiles = files => library.import(files).catch(error => {
    console.error(error);
    status.show('Не удалось сохранить музыку в приложении');
});

// ── клавиатура ─────────────────────────────────────────────────
const repeatCycle = { all: 'one', one: 'off', off: 'all' };
const repeatLabel = { all: 'Повтор полки', one: 'Повтор трека', off: 'Без повтора' };
new Hotkeys([
    { keys: ['Space', 'KeyK'], run: () => controller.toggle(controller.current ?? shelf.focusedId()) },
    { keys: ['ArrowLeft'], run: event => controller.seekBy(event.shiftKey ? -30 : -5) },
    { keys: ['ArrowRight'], run: event => controller.seekBy(event.shiftKey ? 30 : 5) },
    { keys: ['ArrowUp'], run: () => scroller.step(-1) },
    { keys: ['ArrowDown'], run: () => scroller.step(1) },
    { keys: ['Home'], run: () => scroller.jump('first') },
    { keys: ['End'], run: () => scroller.jump('last') },
    { keys: ['Enter'], run: () => { const id = shelf.focusedId(); if (id) controller.toggle(id); } },
    { keys: ['KeyN'], run: () => controller.next() },
    { keys: ['KeyP'], run: () => controller.prev() },
    {
        keys: ['KeyS'],
        run: () => {
            const order = settings.get('order') === 'shuffle' ? 'sequential' : 'shuffle';
            settings.set('order', order);
            status.show(order === 'shuffle' ? 'Перемешать: вкл.' : 'Перемешать: выкл.');
        },
    },
    {
        keys: ['KeyR'],
        run: () => {
            const repeat = repeatCycle[settings.get('repeat')];
            settings.set('repeat', repeat);
            status.show(repeatLabel[repeat]);
        },
    },
    {
        keys: ['KeyM'],
        run: () => {
            settings.set('muted', !settings.get('muted'));
            status.show(settings.get('muted') ? 'Звук выключен' : 'Звук включён');
        },
    },
    { keys: ['Shift+Slash', '?'], run: () => settingsSheet.open('keys') },
    { keys: ['Slash', '/'], run: () => dock.openSearch() },
    { keys: ['Escape'], run: () => dock.closeSearch() },
]).attach();

$('[data-action="menu"]').addEventListener('click', () => librarySheet.open());

// ── запуск ─────────────────────────────────────────────────────
const start = async () => {
    registerServiceWorker();
    install.attach();
    session.attach();
    resume.attach(controller);
    scroller.attach();
    shelf.attach();
    dock.attach();
    progress.attach();
    picker.attach();
    librarySheet.attach();
    settingsSheet.attach();
    empty.setInstallHint(install.iosHint);

    let records = [];
    try {
        records = await library.load();
    } catch (error) {
        console.error(error);
        status.show('Хранилище недоступно — полка не сохранится между запусками', { sticky: true });
    }

    const initial = records.map(record => new Track(record));
    for (const track of initial) tracks.set(track.id, track);
    empty.toggle(!initial.length);

    // «Продолжить с места»: трек на вертушке, один тап — и дальше.
    // Полка сразу встаёт на него и проявляется от него же.
    const saved = resume.read();
    const resumeId = saved && tracks.has(saved.id) ? saved.id : null;
    await shelf.add(initial, { focus: resumeId });
    if (resumeId) controller.cue(resumeId, saved.position);
    booting = false;

    lookup.start();

    // присланное через «Поделиться» и «Открыть с помощью»
    const shared = await inbox.take().catch(() => []);
    if (shared.length) importFiles(shared);
    inbox.listenLaunchQueue(importFiles);
    if (location.search) history.replaceState(null, '', location.pathname);
};

start();
