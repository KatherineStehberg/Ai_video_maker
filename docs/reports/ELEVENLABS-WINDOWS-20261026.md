# ElevenLabs Windows integration, 2026-10-26

- Integrated `origin/feat/elevenlabs-course-voices` into `integracion/avances-joseph`, preserving Joseph's voice settings, model catalog, editor controls and scene cache.
- Added strict source alignment and shared synthesis cache; automatic provider selection excludes ElevenLabs.
- Original SAPI project: `vid_course_RPM-2026-002-local-v2-20261026`. SHA-256 before/after: `437ae8f976fe625c9a0ae6d31d1011954f2d7fe097ee5b0836cac854370a4042`.
- Independent draft: `vid_course_RPM-2026-002-local-v2-20261026-eleven-c9179d53`. Full script and seven scene texts verified equal. Seven compositions copied with their HTML/specifications/render assets. Old narration, captions, exports and render proof cleared in the copy. Voice not yet selected or approved.
- `.env` preserved. API key absent (value never printed). `COURSE_PRODUCTION_ENABLED=0`.
- Existing application on port 4321 left running. Integrated application started on `http://127.0.0.1:4322`; editor, project API and health return HTTP 200. Browser opened to the independent draft.
- Validation: 53 directed tests pass using the repository's isolated test runner; ElevenLabs DOM smoke passes. API simulated, FFmpeg/ffprobe real. Initial broader run passed 61/62 with an assertion wording mismatch; corrected assertion passes in the directed rerun. Initial run created technical test fixtures in default data/output; existing user projects were not overwritten.
- No real ElevenLabs request, sample, full narration or course render performed. No queue execution. Missing local key prevents account voice selection and sample generation. Do not treat simulated test audio as a course sample.
- Next: configure `ELEVENLABS_API_KEY` locally, restart the integrated server with production disabled, load account voices, choose an English voice, generate only a short first-scene sample, and wait for approval. After approval only, generate the new narration and recalculate caption/scene timings from alignment and measured audio. Internal GSAP cue retiming remains a separate composition edit if required.
