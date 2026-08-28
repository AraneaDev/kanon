# Changelog

## [0.0.6](https://github.com/AraneaDev/kanon/compare/v0.0.5...v0.0.6) (2026-08-28)


### Continuous integration

* move off the actions still running on Node 20 ([df0d7fa](https://github.com/AraneaDev/kanon/commit/df0d7fa2ea621cfc85218ac36c581fb6040a31c6))

## [0.0.5](https://github.com/AraneaDev/kanon/compare/v0.0.4...v0.0.5) (2026-08-28)


### Documentation

* correct what the session-start brief says on a resumed session ([13d0b43](https://github.com/AraneaDev/kanon/commit/13d0b4347ada81800a5ac4afb86173062905c224))

## [0.0.4](https://github.com/AraneaDev/kanon/compare/v0.0.3...v0.0.4) (2026-08-28)


### Documentation

* point at the site's marketplace ([6e17b5d](https://github.com/AraneaDev/kanon/commit/6e17b5d27d631c6f4d962c06ed6225b328668172))


### Continuous integration

* assert the marketplace Kanon actually ships from ([27c4b3d](https://github.com/AraneaDev/kanon/commit/27c4b3d1e35e6cf38758c74013812e0108afda25))

## [0.0.3](https://github.com/AraneaDev/kanon/compare/v0.0.2...v0.0.3) (2026-08-27)


### Documentation

* link the README to the project page ([043ccd8](https://github.com/AraneaDev/kanon/commit/043ccd8c0a2d96d70d91b1ff43dee497a470b1a1))

## [0.0.2](https://github.com/AraneaDev/kanon/compare/v0.0.1...v0.0.2) (2026-08-27)


### Features

* brief Claude at session start, and colour the report for a terminal ([3311b54](https://github.com/AraneaDev/kanon/commit/3311b5404800ff34ed48c004d30146e4c55d80fd))


### Fixes

* never let an unset CLAUDE_PLUGIN_ROOT fail a session ([e8d4ce2](https://github.com/AraneaDev/kanon/commit/e8d4ce2c6650ec2ceffa308610099a95ec766c50))


### Documentation

* show the report, the brief and the self-doubt sections as screenshots ([29b1ba1](https://github.com/AraneaDev/kanon/commit/29b1ba12b2ed8428e7fbd21ccac943110c35a4e0))


### Tests

* cover the failure branches discovery and pruning never reached ([b5a55a8](https://github.com/AraneaDev/kanon/commit/b5a55a899120d735a5024f92b34d714e94f04228))

## 0.0.1 (2026-08-27)


### Features

* add marketplace manifest so the plugin can be installed ([2d0dc0f](https://github.com/AraneaDev/kanon/commit/2d0dc0f0590d076fe33ac6a58272e0370d237559))
* assemble the candidate set and apply claudemdexcludes ([e029660](https://github.com/AraneaDev/kanon/commit/e029660a5ce5abf809c630fc5ba234dece27dc32))
* classify a loaded instruction file by where it came from ([8d1c41d](https://github.com/AraneaDev/kanon/commit/8d1c41d426307c62ced6f4ba13a7c25dccefe8e3))
* discover rules directories recursively and label path-scoped rules ([6afc640](https://github.com/AraneaDev/kanon/commit/6afc64067792266ce5abd4f2c983163dd5e4866d))
* enumerate instruction candidates from the ancestor walk and fixed scopes ([75590ad](https://github.com/AraneaDev/kanon/commit/75590ad05b8dd7497f8234ed7cac1c849883841d))
* follow claude.md imports to depth four, skipping code blocks ([768c235](https://github.com/AraneaDev/kanon/commit/768c235c3bb168b7abc32b026e8e1db70077b844))
* join recorded loads against candidates and flag model disagreement ([b97bd46](https://github.com/AraneaDev/kanon/commit/b97bd46f02935be709d383f3eaf98c5040dffc40))
* record instruction-load payloads from the hot hook path ([2bb21bb](https://github.com/AraneaDev/kanon/commit/2bb21bb9008a334f8383e076bc9927228519ef06))
* render the session report ([1c253b3](https://github.com/AraneaDev/kanon/commit/1c253b322252573bf0e48a32cfdb0a4a1efdde61))
* report on demand, warn on a foreign load, and write at session end ([1b03bc3](https://github.com/AraneaDev/kanon/commit/1b03bc37031f8e2892362665961eb45ffccf73ab))
* skip oversized instruction files and prune old records ([545ee22](https://github.com/AraneaDev/kanon/commit/545ee228e5b5fce859d31ccaa8be6c8996fa3844))


### Fixes

* emit valid JSON for non-JSON payloads with escaped unparsed field ([3953f86](https://github.com/AraneaDev/kanon/commit/3953f86a7c505f5933c8c095845f9490b998a52e))
* guarantee column separation in the rendered report ([358662d](https://github.com/AraneaDev/kanon/commit/358662d7da55090b19ceb1d23946dc593f512f18))
* handle utf-8 bom in path-scoped detection and strengthen symlink cycle test ([b540518](https://github.com/AraneaDev/kanon/commit/b540518099a08afe4ed178e252d837a34d72bca6))
* keep model-disagreeing loads in the loaded report, not just modelDisagrees ([97940c4](https://github.com/AraneaDev/kanon/commit/97940c4ae7a48ae8e948532155c57b869ddf5d1a))
* match session roots through realpath and stop tests touching the real home ([6e95158](https://github.com/AraneaDev/kanon/commit/6e951589c4cdee83e3c26a7724e802107c96da32))
* note oversized, unreadable and missing-target files instead of skipping them silently ([35e910d](https://github.com/AraneaDev/kanon/commit/35e910da547354241e6b469f40ce795423575669))
* resolve session roots through symlinks so project files are not called foreign ([4604449](https://github.com/AraneaDev/kanon/commit/4604449901e00684ef3055002d0431b1d6872fd8))
* root the subdirectory walk at cwd and exclude imports seeded by excluded files ([83bf6dc](https://github.com/AraneaDev/kanon/commit/83bf6dc7ec802161ca95946dcee4129872295abb))
* scope the session fallback to the repository it was recorded in ([ae544ce](https://github.com/AraneaDev/kanon/commit/ae544ce51808ef8e95493733b63ccf82331e0717))
* seed files excluded from map, depth boundary tests, regex punctuation, unterminated fences, tilde expansion test ([07abf55](https://github.com/AraneaDev/kanon/commit/07abf5540991099af81d20ed6c80238f090f73e1))
* wire the real import map into reports and quiet false model alarms ([205c9bf](https://github.com/AraneaDev/kanon/commit/205c9bfa5cfd4ed0967f9ca5834ed6f14209d358))


### Documentation

* describe the kanon marketplace rather than reusing the hub blurb ([27eac50](https://github.com/AraneaDev/kanon/commit/27eac5001939ef20798f4ab0175520ada8d095a2))
* design kanon, an instruction-load ledger with origin classification ([99eb299](https://github.com/AraneaDev/kanon/commit/99eb299e00df29421b3ce682119ba460b6908a3d))
* implementation plan for kanon ([22e0a9b](https://github.com/AraneaDev/kanon/commit/22e0a9b297b1a67263d785c8353ddcc9de6942e9))
* rewrite the readme in the house format and add the licence file ([e3c1342](https://github.com/AraneaDev/kanon/commit/e3c1342ce80a4e632b3288b90e412691079ce5b7))


### Tests

* add order and deduplication coverage for walkCandidates ([2e4300b](https://github.com/AraneaDev/kanon/commit/2e4300b67d17bc0f98068448f1b0eb58199e3bd4))
* resolve temp fixtures through realpath so macos compares like with like ([e4140a0](https://github.com/AraneaDev/kanon/commit/e4140a036ad5cf1f8b06665f0413567a800ea347))


### Continuous integration

* add the test, lint, manifest and docs workflows plus release-please ([ca53992](https://github.com/AraneaDev/kanon/commit/ca5399292b4c83be94bf66704f00ff17186016ee))
