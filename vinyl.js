const template = document.getElementById('vinyl-template');

export const createVinyl = track => {
    const vinyl = template.content.firstElementChild.cloneNode(true);

    const sideAlbum = vinyl.querySelector('.vinyl__side__album');
    const sideTitle = vinyl.querySelector('.vinyl__side__title');
    const frontSide = vinyl.querySelector('.vinyl__frontside');
    const backSide = vinyl.querySelector('.vinyl__backside');

    sideAlbum.textContent = track.album;
    sideTitle.textContent = track.title;

    if (track.cover) {
        frontSide.src = track.cover;
        backSide.src = track.cover;
    }
    frontSide.alt = `${track.album} — ${track.title}`;

    // на пластинку идёт только этикетка; сам винил чёрный
    const label = vinyl.querySelector('.disc__label');
    if (label && track.cover) label.style.setProperty('--disc-art', `url("${track.cover}")`);

    if (track.spine) {
        vinyl.style.setProperty('--spine', track.spine);
        vinyl.style.setProperty('--spine-text', track.spineText);
    }

    return vinyl;
};