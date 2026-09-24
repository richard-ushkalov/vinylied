import { makeFixtures } from '../fixtures/make-fixtures.mjs';

export default async () => {
    await makeFixtures(new URL('../fixtures/.generated', import.meta.url).pathname);
};
