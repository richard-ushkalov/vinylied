// Модуль emscripten: фабрика, которая загружает chromaprint.wasm.
declare const createChromaprintModule: (options?: object) => Promise<any>;
export default createChromaprintModule;
