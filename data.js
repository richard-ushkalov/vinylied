import { parseBlob, selectCover } from 'music-metadata';

export const createInputReader = input => {
    return {
        onChange: callback => {
            input.addEventListener('change', () => callback([...input.files]));
        }
    };
}

export const readTrack = async file => {
    const { common } = await parseBlob(file).catch(() => ({ common: {} }));

    const cover = common.picture?.length ? selectCover(common.picture) : null;
    const coverUrl = cover
        ? URL.createObjectURL(new Blob([cover.data], { type: cover.format }))
        : null;

    const url = URL.createObjectURL(file);
    
    return {
        title: common.title || 'Title',
        album: common.album || 'Album',
        cover: coverUrl || null,
        src: url,
        dispose() {
            if (coverUrl) URL.revokeObjectURL(coverUrl);
            URL.revokeObjectURL(url);
        }
    };
};