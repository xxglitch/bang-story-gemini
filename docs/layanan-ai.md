# Layanan AI dan kunci API

Semua panggilan ke layanan luar dilakukan di **proses utama** (`src/main/services/`). Renderer tidak pernah
memegang kunci API.

## Kunci API (BYOK)

Pengguna memasukkan kuncinya sendiri di **Pengaturan › Layanan AI dan kunci**.

- Disimpan di tabel `secrets` setelah dienkripsi dengan Electron `safeStorage`. Di Windows ini memakai DPAPI,
  terikat ke akun Windows pengguna, jadi salinan `studio.db` di komputer lain tidak bisa membuka kuncinya.
- Kunci kriptonya dibuat saat startup (`warmUpEncryption`) supaya tidak hilang kalau aplikasi ditutup paksa tepat
  setelah menyimpan kunci pertama.
- `requireSecret(provider)` melempar error berbahasa Indonesia kalau kunci belum ada.
- `revealSecret` hanya dipanggil tombol "tampilkan kunci" di Pengaturan.
- **Jangan pernah** menulis kunci ke log, pesan error, file, URL, atau mengirimnya ke layanan lain.

| Penyedia (`ApiProvider`) | Dipakai untuk |
|---|---|
| `gemini` | gambar, lembar karakter, video (Veo), LLM (naskah/visual), dan Gemini TTS |
| `elevenlabs` | TTS |
| `openrouter`, `groq`, `custom` | LLM lewat API kompatibel OpenAI |

## LLM (`services/llm.ts`, `services/gemini.ts`)

- `generateJson({ system, prompt, schema, name })` memanggil penyedia aktif (`settings.llmProvider` +
  `llmModels[provider]`).
  - Gemini: `@google/genai` dengan `responseJsonSchema` (dan cadangan: skema ditulis di system instruction).
  - Lainnya: `/chat/completions`, dicoba berurutan `json_schema` (strict) → `json_object` → teks biasa, lalu JSON
    diambil dari teks (`extractJson`) untuk model yang tidak mendukung structured output.
- `listModels(source)`: daftar model live dari penyedia, dicache di tabel `cache` dan disegarkan saat basi.
- **Menambah penyedia LLM baru** yang kompatibel OpenAI: tambahkan ke `LlmProvider` dan `ApiProvider`
  (`types.ts`), `LLM_PROVIDERS` (`shared/models.ts`), konfigurasi base URL di `llm.ts`, dan `DEFAULT_SETTINGS.llmModels`.

## TTS

| Penyedia | File | Catatan |
|---|---|---|
| Gemini TTS | `services/gemini.ts` | PCM 24 kHz → WAV; daftar suara dari Voice Library (`listVoices`, cache 24 jam) dengan cadangan statis di `shared/models.ts`; contoh suara bawaan di `renderer/src/assets/voices` |
| ElevenLabs | `services/elevenlabs.ts` | memakai endpoint with-timestamps untuk waktu per kata; tag `<...>` diubah ke `[tag]` untuk model v3, atau ke `<break>` untuk model lama (`toElevenLabsText`) |

Narasi selalu dibuat satu rekaman utuh lalu dipotong. Lihat [alur-produksi.md](alur-produksi.md#4-narasi-srcmainnarrationts).

## Gambar dan video (`services/geminiMedia.ts`, `shared/media.ts`)

Semuanya memakai kunci Gemini yang sama. Tidak ada kunci atau layanan terpisah.

- **Gambar dan lembar karakter**: Nano Banana lewat `generateContent` (`@google/genai`) dengan
  `responseModalities: ['IMAGE']` dan `imageConfig` (rasio, ukuran 1K/2K/4K). Satu permintaan langsung membalas
  gambarnya, jadi progresnya hanya perkiraan waktu (`withProgress` di `generation.ts`). Lembar karakter dikirim
  sebagai gambar inline sebelum prompt (maks 6, supaya muatan permintaan tidak membengkak).
- **Video**: Veo lewat REST `models/<id>:predictLongRunning` dengan gambar klip sebagai frame pertama. Operasi dipolling
  (`waitForVideo`, tiap ±5 detik) sampai selesai, lalu file diunduh dari URI-nya (`downloadVideo`, kunci hanya dikirim
  ke `*.googleapis.com`). Nama operasi disimpan di job (`remote_id`), jadi `resumeJobs()` bisa melanjutkan polling
  setelah aplikasi dibuka ulang. Operasi Veo tidak bisa dibatalkan di sisi Google; membatalkan job hanya berhenti menunggu.
- Aturan Veo yang dipakai di `fitDuration`: durasi 4, 6, atau 8 detik; 1080p dan 4K hanya 8 detik; resolusi 4K
  tidak ada di Veo 3.1 Lite. Veo selalu membuat suara sendiri, jadi setiap prompt diakhiri `NO_MUSIC`.
- Veo dan sebagian model gambar butuh akun Google AI dengan penagihan aktif. Pesan error 401/403/404 menyebutnya
  (`fromStatus`). Error 429 dan 5xx dicoba ulang sampai 5 kali.
- Filter keamanan: gambar yang ditolak (`finishReason`/`blockReason`) dan video yang disaring
  (`raiMediaFilteredReasons`) menjadi pesan berbahasa Indonesia.

### Katalog model dan harga (`src/shared/media.ts`)

Daftar kecil di kode, bukan JSON dari API: 4 model gambar (Nano Banana 2.1, 2, Pro, 2 Lite) dan 3 model video
(Veo 3.1 Lite, Fast, penuh). Satu entri memuat id model, resolusi, durasi, dan harga USD per gambar atau per detik
video. Harga hanya untuk perkiraan di layar (`estimateUsd`); periksa
<https://ai.google.dev/gemini-api/docs/pricing> saat memperbarui. Harga Nano Banana Pro dan Veo 3.1 Fast belum dicek
ulang ke halaman resmi.

- **Menambah model**: tambahkan entri di `IMAGE_MODELS` atau `VIDEO_MODELS`. Id model harus persis seperti di
  dokumentasi Gemini API. Ikon keluarga model diatur di `components/ModelLogo.tsx`.
- Model bawaan: `DEFAULT_IMAGE_MODEL` dan `DEFAULT_VIDEO_MODEL`. Id model yang tidak dikenal (misalnya dari
  proyek lama yang memakai model Higgsfield) otomatis jatuh ke model bawaan.

## Whisper lokal (`src/main/whisper.ts`)

- Biner: `resources/whisper/whisper-cli.exe` + DLL (whisper.cpp, lisensi MIT). Saat ini hanya untuk Windows.
- Model: `ggml-small.bin` (sekitar 488 MB) dari Hugging Face (`ggerganov/whisper.cpp`), diunduh di Pengaturan ke
  `<folder data>\models\whisper`, bisa dijeda dan dilanjutkan (HTTP Range), lalu dicek SHA-256. Untuk pengembangan, `STUDIO_WHISPER_URL` bisa menunjuk salinan lokal.
- Dijalankan di antrean `whisper` (satu per satu). Detail argumennya di [alur-produksi.md](alur-produksi.md#5-caption-akurat-whisper-lokal).

## YouTube (halaman About)

Video tutorial diputar lewat iframe `https://www.youtube.com/embed/<id>`. Sejak 2025 YouTube mewajibkan pemutar
embed mengirim identitas lewat header HTTP Referer (tanpa itu: Error 153). Aplikasi yang memuat halaman dari
`file://` tidak mengirim Referer, jadi `identifyToYouTube()` (`src/main/index.ts`) menambahkan
`Referer: https://id.bangtutorial.bangstory/` (ID aplikasi) hanya untuk permintaan embed. Iframe tanpa
autoplay, supaya putaran dari pengguna terhitung sebagai view.

## Membuka tautan

`app:openExternal` hanya menerima URL `https://` dan membukanya di browser bawaan. Pakai ini untuk semua tautan
ke luar (dokumentasi penyedia, channel YouTube, Suno, dan lainnya).
