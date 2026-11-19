# Társasház

Társasházi közös költség elszámoló: <https://tarsashaz.laszlobiri.com>

Négy lakás (fsz-1, fsz-2, em-3, em-4) osztozik a közös költségeken. Időszakonként
tételek (megnevezés, kategória, összeg, ki fizette, ki száll be, felosztás), a
lezáráskor a legkevesebb utalás; vízóra-leolvasások; kimutatások.

- Felosztás: tulajdoni hányad, lakók száma, vízfogyasztás (az almérők arányában, a kerti
  rész is), egyenlő, kézi. Egész forintra kerekítve, pontosan kiadja az összeget.
- Nevek nincsenek: a felhasználók egy-egy lakáshoz tartoznak (a laszlobiri.com/admin/
  oldalon). A tételnevekbe sem kerül név.
- Az adat a közös Supabase-projekt `th_*` tábláiban van; a séma, a jogok és a tesztek a
  `laszlobiri-com` repóban (`supabase/migrations/…_tarsashaz.sql`, `supabase/tests/010_tarsashaz.test.sql`,
  `scripts/tarsashaz-smoke.mjs`). Olvasni a társasház oldal jogával lehet, írni csak a
  kezelő tud; az utalást az utaló és a fogadó lakás is jelölheti.
- A repóba nem kerül elszámolási adat.
- Kiadáskor az `index.html`-ben az `app.js?v=` számát növelni kell, különben a böngésző (főleg mobilon) még percekig a régi `app.js`-t használhatja.
