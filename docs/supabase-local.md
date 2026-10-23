# Supabase local และการย้ายไป VPS

## เริ่มในเครื่อง

ต้องมี Node.js 24, Docker ที่เปิดทำงานอยู่ และ Supabase CLI (ชุดนี้ตรวจด้วย CLI 2.117.0 / PostgreSQL 17)
บน macOS ติดตั้ง CLI ได้ด้วย `brew install supabase/tap/supabase` ตาม [คู่มือ CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)

```bash
npm ci
npm run db:setup
npm run dev
```

`db:setup` / `db:start` ทำงานเหมือนกัน: เปิด local stack บน Docker network `hack-hatyai-local` โดยขอ bind พอร์ตกับ `127.0.0.1`, สำรองตารางแอป, รัน migrations ที่ยังขาด, upsert สถานที่จาก seed, เติม URL/public key ใน `.env.local` และตรวจตารางทั้ง 7 ตาราง โดยไม่ reset ข้อมูลเดิม
ถ้า stack เดิมใช้ network อื่น คำสั่งจะสำรองข้อมูลและ restart เฉพาะ Supabase ของโปรเจ็กต์นี้เพื่อเปลี่ยน network ส่วน stack ของโปรเจ็กต์อื่นไม่ถูกหยุด

**Docker Desktop บน macOS:** เครื่องนี้ยัง publish พอร์ตเป็น `0.0.0.0`/`::` แม้กำหนด network option แล้ว ซึ่งตรงกับ [ปัญหาที่รายงานกับ Supabase](https://github.com/supabase/supabase/issues/51027) สคริปต์ตรวจและแจ้งสถานะนี้จริง ไม่อ้างว่าพอร์ตถูกจำกัดสำเร็จ หากต้องการจำกัด LAN ให้ตั้ง Docker Desktop → Settings → Resources → Network → Port binding behavior → Localhost by default แล้ว restart ชุด local และตรวจด้วย `docker port supabase_kong_hack-hatyai` อีกครั้ง การตั้งค่านี้มีผลกับ Docker Desktop ทั้งเครื่อง ระหว่างทดสอบให้ใช้เครือข่ายที่ไว้ใจได้และไม่ forward พอร์ตนี้ออกอินเทอร์เน็ต

| ส่วน | URL / พอร์ต |
|---|---|
| เว็บพัฒนา | http://127.0.0.1:5180 |
| Supabase API | http://127.0.0.1:56321 |
| Supabase Studio | http://127.0.0.1:56323 |
| PostgreSQL | 127.0.0.1:56322 |

```bash
npm run db:status    # ตรวจการเชื่อมต่อและจำนวนแถว ไม่พิมพ์ keys
npm run db:test      # ทดสอบ API จริง: บันทึก/อ่าน/แก้ไข, transaction, PostGIS, สิทธิ์อันดับเกม
npm run db:env       # เติมเฉพาะค่า local ใน .env.local ใหม่ แล้ว restart Vite ถ้าเปิดอยู่
npm run db:migrate   # สำรอง แล้วลง migration/seed เพิ่ม โดยไม่ล้างข้อมูล
npm run db:backup    # สำรอง public schema เป็น PostgreSQL custom archive
npm run db:stop      # หยุด stack และเก็บข้อมูลไว้
```

ไฟล์สำรองอยู่ใน `.cache/backups/*.dump` (ไม่เข้า Git) เป็น schema และข้อมูล **ตารางแอปใน public เท่านั้น** ไม่รวม Auth users, Storage objects, secrets หรือ migration history ของ CLI ข้อมูลปัจจุบันของแอปยังไม่ใช้ Auth/Storage
คัดลอก backup ไปเก็บอีกเครื่องด้วย เพราะไฟล์ในเครื่องเดียวไม่ช่วยกรณีดิสก์เสีย
`db:test` สร้างข้อมูลชั่วคราวของตัวเอง แล้วลบทิ้งด้วย admin key ใน Node process; key นี้ไม่ถูกเขียนลงไฟล์ frontend

`npm run db:reset` เป็นคำสั่งล้างข้อมูลเพื่อสร้างฐานข้อมูลใหม่ ใช้เฉพาะเมื่อตั้งใจเริ่มใหม่ หลังสำรองข้อมูลแล้วเท่านั้น

## เมื่อย้ายไป VPS

ตัวแอปยังเรียก Supabase API แบบเดิม จึงย้ายไป [Supabase self-host ผ่าน Docker](https://supabase.com/docs/guides/self-hosting/docker) ได้โดยไม่ต้องเขียน backend ใหม่
ใช้ PostgreSQL major version 17 ให้ตรงกับ local และเริ่มจากสเปกของเอกสารผู้ให้บริการ: 2 CPU cores, RAM 4 GB, SSD 40 GB สำหรับ stack เต็ม แล้ววัดโหลดจริง กลุ่ม 50 คนยังต้องทดสอบพร้อมกันก่อนเปิด

1. ติดตั้งชุด **self-host สำหรับเซิร์ฟเวอร์** ตามคู่มือข้างบน ไม่ใช้ `supabase start` เป็นบริการสาธารณะ ([ข้อกำหนด local development](https://supabase.com/docs/guides/local-development))
2. ตั้ง domain, HTTPS reverse proxy และ secrets ใหม่ทั้งหมดบน VPS; จำกัด Studio และพอร์ต PostgreSQL ไว้ภายในหรือผ่าน SSH tunnel เปิดเฉพาะเว็บ/API ที่ต้องใช้
3. จัดการสิทธิ์ก่อนเปิดให้ผู้ใช้: `scenarios`, `phases`, `simulation_runs`, `run_place_impacts`, `weather_cache` ยังเป็น `prototype open access` ผู้ถือ public key แก้/ลบข้อมูลร่วมกันได้ ต้องเพิ่ม Auth + ownership/RLS หรือจำกัดผู้ทดสอบผ่านระบบควบคุมการเข้าถึง; `game_results` ให้ public อ่าน/เพิ่มได้ แต่ยังไม่มี rate limit หรือการยืนยันคะแนนจากเซิร์ฟเวอร์
4. **กรณีเริ่มฐานข้อมูลใหม่**: รันไฟล์ `supabase/migrations/*.sql` ตามลำดับกับ PostgreSQL ของ self-host แล้วรัน `supabase/seeds/places.sql` ด้วยสิทธิ์ admin (self-host Docker ไม่ได้อ่าน migrations ของ repo นี้ให้อัตโนมัติ) Presets จะถูกเพิ่มโดยแอปเมื่อเปิดครั้งแรก
5. **กรณีย้ายข้อมูลเดิม**: หยุดการเขียนชั่วคราวแล้วรัน `npm run db:backup` นำไฟล์ไป VPS ที่สร้าง migrations แล้วและตารางแอปยังว่าง ก่อน seed/เปิดเว็บ จากนั้นใช้ `pg_restore --data-only --no-owner --no-privileges --exit-on-error --dbname="$VPS_DATABASE_URL" app.dump` ด้วย role postgres ของ Supabase และเครือข่ายภายใน/SSH tunnel **อย่า restore ทับฐานข้อมูลที่มีข้อมูล** หลัง restore ตรวจตาราง/สิทธิ์และ upsert seed สถานที่ได้ ถ้ามี Auth/Storage เพิ่มในอนาคต ต้องสำรองและย้ายส่วนนั้นเพิ่มตาม [คู่มือ restore](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
6. ตั้ง `VITE_SUPABASE_URL` เป็น HTTPS URL ที่เบราว์เซอร์ผู้ใช้เข้าถึงได้ และ `VITE_SUPABASE_ANON_KEY` เป็น public/anon key ของ VPS; ห้ามใช้ `localhost` หรือชื่อ container เป็น frontend URL และห้ามใส่ service-role/secret key ลงตัวแปร `VITE_`
7. Build ใหม่ด้วย `npm ci` และ `npm run build` หลังตั้งค่า production แล้ว เสิร์ฟ `dist/` ด้วยเว็บเซิร์ฟเวอร์จริง พร้อม cache ไฟล์เมืองและให้ไฟล์ที่หายตอบ 404 ตัวแปร Vite ถูกฝังตอน build และ `.env.local` มีลำดับความสำคัญสูง จึงไม่ควรคัดลอก `.env.local` จากเครื่องพัฒนาไป build บน VPS
8. ทดสอบเว็บจากเครือข่ายภายนอก การบันทึก/อ่านผล สิทธิ์ข้อมูล และกำหนด backup/restore บน VPS เป็นประจำ

ตอนนี้ชุด local พร้อมสำหรับพัฒนาและทดสอบบนเครื่อง ยังไม่ได้เปิด VPS หรือเปลี่ยน prototype policies เป็นระบบผู้ใช้จริง
