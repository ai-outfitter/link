# Changelog

## [1.6.0](https://github.com/ai-outfitter/link/compare/v1.5.0...v1.6.0) (2026-08-13)


### Features

* **report:** resolve inherited catalog sources ([2ee10e1](https://github.com/ai-outfitter/link/commit/2ee10e1ae508b71d0e529b8b88c4d6bf6a488e52))

## [1.5.0](https://github.com/ai-outfitter/link/compare/v1.4.0...v1.5.0) (2026-08-13)


### Features

* **report:** band the plan and the milestones by the rung they gate ([a57c764](https://github.com/ai-outfitter/link/commit/a57c7644cc7bd315d2e5671c89fb0b960a67c105))
* **report:** credit resident agents at triggered-agents ([71a7911](https://github.com/ai-outfitter/link/commit/71a7911e659bee73e7f0520b2d835478a4e4121a))
* **report:** decide the evidence gate through pluggable backends ([0ea634f](https://github.com/ai-outfitter/link/commit/0ea634f218b0accb2828b4455447da5508ea2da4))
* **report:** keep direct-push and bypass facts when no backend matches ([c88be90](https://github.com/ai-outfitter/link/commit/c88be90d19e6286635e1459a083631465f3917ba))
* **report:** link repositories to their forge and surface the dotagents catalog ([e83c438](https://github.com/ai-outfitter/link/commit/e83c438bcb4a85c071f3b074231ef698e80e8b91))
* **report:** name issue triage and pull-request review as the on-ramp ([358ef35](https://github.com/ai-outfitter/link/commit/358ef35eb1203306611dd10036435b92b0bcceba))
* **report:** rank the findings as a plan for reaching the next rung ([21b59ab](https://github.com/ai-outfitter/link/commit/21b59abc23101a06bf2666bb11e7b1fecb25b900))
* **report:** read each repo's declared catalog sources ([ff581bb](https://github.com/ai-outfitter/link/commit/ff581bb4cc94ed304bdd918430762e0f85b1808b))
* **report:** read issue templates and CODEOWNERS as signals ([8b19cd0](https://github.com/ai-outfitter/link/commit/8b19cd0af854fda655382c4b79ed80aaf37eef69))
* **report:** report a repo pin competing with the org catalog as a finding ([4ad7907](https://github.com/ai-outfitter/link/commit/4ad790784a4ef18a3333ff80de8c6c81a7ea5dc4))
* **report:** require an evidence gate to be exercised, not merely required ([fbabbdb](https://github.com/ai-outfitter/link/commit/fbabbdbd64d8e2459a9f5fc68149ce672b6870e8))
* triage issues with an agent resolved from the catalog ([#18](https://github.com/ai-outfitter/link/issues/18)) ([903816f](https://github.com/ai-outfitter/link/commit/903816fcc9b18a0041daaebfe132d85bbb5174c7))
* **web:** render the governance baseline at /baseline ([47b576f](https://github.com/ai-outfitter/link/commit/47b576fcca5040fb32d228e7abbffb7557d26f51))


### Bug Fixes

* **evidence:** stop matching dependency audits as evidence gates ([72375c7](https://github.com/ai-outfitter/link/commit/72375c7b2cd1bed2ec669e2a01dcd4c70b671b0d))
* **report:** count pull-request review workflows as agent workflows ([7bfa8b3](https://github.com/ai-outfitter/link/commit/7bfa8b3ecfd4572183c281e4ce80d4f08b138f0c))
* **report:** drop the hardcoded ~/repos/ai-outfitter default source ([5950226](https://github.com/ai-outfitter/link/commit/59502266e188f6a8bc3af62794eb176ce29527e5))
* **report:** report an unreadable evidence gate as unknown, not fail ([ab23283](https://github.com/ai-outfitter/link/commit/ab232835880b1922e850d12446d61d7d376d76d2))
* track the action's v1 tag instead of a commit ([#20](https://github.com/ai-outfitter/link/issues/20)) ([68b37a4](https://github.com/ai-outfitter/link/commit/68b37a47c6b86c2c1bacef158226a3d35299426d))
* **web:** label every source type on the org card ([c82559d](https://github.com/ai-outfitter/link/commit/c82559d9d131594e5bb4031a0a204502bc871e55))

## [1.4.0](https://github.com/ai-outfitter/link/compare/v1.3.0...v1.4.0) (2026-08-10)


### Features

* **report:** accept a single repository, not only an org ([#15](https://github.com/ai-outfitter/link/issues/15)) ([332e2a2](https://github.com/ai-outfitter/link/commit/332e2a2925f3edff259f283eae111b9150606e08))

## [1.3.0](https://github.com/ai-outfitter/link/compare/v1.2.0...v1.3.0) (2026-08-10)


### Features

* **cli:** add `review` — scan then serve — and make it the container default ([#13](https://github.com/ai-outfitter/link/issues/13)) ([d78e40c](https://github.com/ai-outfitter/link/commit/d78e40c8f94e9b5bf489ad4bd68af23a42601bbc))

## [1.2.0](https://github.com/ai-outfitter/link/compare/v1.1.0...v1.2.0) (2026-08-10)


### Features

* **container:** serve the report from the image ([#11](https://github.com/ai-outfitter/link/issues/11)) ([a3391f5](https://github.com/ai-outfitter/link/commit/a3391f5f1f451e6182fb915a216f3a16d199168f))

## [1.1.0](https://github.com/ai-outfitter/link/compare/v1.0.2...v1.1.0) (2026-08-10)


### Features

* **web:** ship the site prebuilt so `link web` works from the package ([#9](https://github.com/ai-outfitter/link/issues/9)) ([a4f4e34](https://github.com/ai-outfitter/link/commit/a4f4e34a899c6c08a2915c367e4626af181185b0))

## [1.0.2](https://github.com/ai-outfitter/link/compare/v1.0.1...v1.0.2) (2026-08-10)


### Bug Fixes

* **release:** pin node 24 so npm can use trusted publishing ([#6](https://github.com/ai-outfitter/link/issues/6)) ([afdeee5](https://github.com/ai-outfitter/link/commit/afdeee5dd995c4b215e0276d70d3a1e5ea0bbd33))

## [1.0.1](https://github.com/ai-outfitter/link/compare/v1.0.0...v1.0.1) (2026-08-10)


### Bug Fixes

* **release:** authenticate to npm with trusted publishing, not a token ([#4](https://github.com/ai-outfitter/link/issues/4)) ([a9f59b1](https://github.com/ai-outfitter/link/commit/a9f59b10f4627a7f7b441904a29bebb912cc9173))

## 1.0.0 (2026-08-10)


### Features

* **code:** org report tool (Bun + zod) and Astro site for report and workflows ([fb81aea](https://github.com/ai-outfitter/link/commit/fb81aea382cca92ea825afecc13276ca14c492ac))
* **report:** contributor-docs convention signals ([3553197](https://github.com/ai-outfitter/link/commit/35531971df16e191e685c3786f7cfc42fdee7263))
* **report:** e2e smoke test, local folder sources, XDG source registry ([eaef504](https://github.com/ai-outfitter/link/commit/eaef5047fbf538d71452c5c2efc27bebcd381578))
* **report:** merge sources by canonical identity from git remotes ([647a9d6](https://github.com/ai-outfitter/link/commit/647a9d631114c7844a64756a0eabe6be282a324b))
* **report:** milestone-based org matrix; roles; honest workflow signals ([80421e7](https://github.com/ai-outfitter/link/commit/80421e724d441f053f8705d75f8c3c9db3ba9e75))
* **report:** rank only repos active in the last 7 days; hide the rest ([23f8d97](https://github.com/ai-outfitter/link/commit/23f8d97d62b5464aa77e80d43732008b9192b0db))
* **report:** recognize governed catalogs; adoption now moves the score ([5835517](https://github.com/ai-outfitter/link/commit/5835517362205cc8a954307c1ad8415bbfd4cffe))
* seed catalog with the SDLC reference collection from community-profiles PR [#30](https://github.com/ai-outfitter/link/issues/30) ([e591e2e](https://github.com/ai-outfitter/link/commit/e591e2e95c445044bc89d786bf84a9c90aa93b9d))
* **web:** blueprint redesign; workflows render as clean process DAGs ([f8922cf](https://github.com/ai-outfitter/link/commit/f8922cfd58984377e3f561a2700cf8d677f67474))
* **web:** manage report sources from the UI ([3f0de31](https://github.com/ai-outfitter/link/commit/3f0de313b2ad727f8253c1e88331004c4646f8a9))
* **web:** process-viewer graph for defined workflows ([f087724](https://github.com/ai-outfitter/link/commit/f0877241fd10bbe2be57106cb61b148bb37795dd))


### Bug Fixes

* **report:** residency counts the catalog-apart-from-deployment shape ([1c47cc5](https://github.com/ai-outfitter/link/commit/1c47cc571bd23a363438d5dc7d281632e189d137))
