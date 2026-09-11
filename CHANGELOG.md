# Changelog

## [1.0.1](https://github.com/wego/wego-ai/compare/cli-v1.0.0...cli-v1.0.1) (2026-09-03)


### Chores

* release 1.0.1 ([#1839](https://github.com/wego/wego-ai/issues/1839)) ([3757207](https://github.com/wego/wego-ai/commit/37572074fac21afa36b772ff70c84595786daf89))

## [1.0.0](https://github.com/wego/wego-ai/compare/cli-v0.10.0...cli-v1.0.0) (2026-09-02)


### Chores

* release 1.0.0 ([562b5b0](https://github.com/wego/wego-ai/commit/562b5b00d7caed4efd35a58ac6d10568241d62f7))

## [0.10.0](https://github.com/wego/wego-ai/compare/cli-v0.9.0...cli-v0.10.0) (2026-09-02)


### Features

* **cli:** give the plugin repo a README that sells it and an Apache 2.0 licence ([#1824](https://github.com/wego/wego-ai/issues/1824)) ([0d90009](https://github.com/wego/wego-ai/commit/0d900097b02e1ed791296ccb3634e574f9224a73))

## [0.9.0](https://github.com/wego/wego-ai/compare/cli-v0.8.1...cli-v0.9.0) (2026-09-02)


### Features

* **api,cli:** carry the caller's own UTC offset into Genzo ([#1802](https://github.com/wego/wego-ai/issues/1802)) ([1b75779](https://github.com/wego/wego-ai/commit/1b7577982cb11d893818b8b8ff7af0f618cbb430))
* **api:** capture CLI build and OS metadata in Genzo ([#1790](https://github.com/wego/wego-ai/issues/1790)) ([3bd16e5](https://github.com/wego/wego-ai/commit/3bd16e51139b3380ecfb0013050e7fa10d1eb9f4))
* **api:** forward CLI user agent to Genzo ([#1788](https://github.com/wego/wego-ai/issues/1788)) ([af5ca1f](https://github.com/wego/wego-ai/commit/af5ca1fda1853c8f09c8df2badb8dd82300ff13b))
* **cli,api:** send the id_token assertion so Genzo can name the user ([#1813](https://github.com/wego/wego-ai/issues/1813)) ([a7a25f8](https://github.com/wego/wego-ai/commit/a7a25f86c21435e7e69f0e96112df3e394ba8437))
* **cli,api:** the command name is the install's identity ([#1754](https://github.com/wego/wego-ai/issues/1754)) ([9affdf2](https://github.com/wego/wego-ai/commit/9affdf2f558020ed3940302a21e6a3d73c8f356a))
* **cli:** declare skill compatibility in SKILL.md frontmatter ([#1796](https://github.com/wego/wego-ai/issues/1796)) ([5b6fbaf](https://github.com/wego/wego-ai/commit/5b6fbaf351947a3e4982a97c5c5e7635568ec423))
* **cli:** publish the wego plugin repo from a promote ([#1801](https://github.com/wego/wego-ai/issues/1801)) ([93065b0](https://github.com/wego/wego-ai/commit/93065b08dc72b34bfb225a4993447907d0da2bad))
* **cli:** verify the plugin repo publish, and authenticate it with a GitHub App ([#1819](https://github.com/wego/wego-ai/issues/1819)) ([d67bb92](https://github.com/wego/wego-ai/commit/d67bb920af221f8664813af163f96f3139a8b0d4))


### Refactors

* **cli:** cut the never-run public skill mirror lane ([#1795](https://github.com/wego/wego-ai/issues/1795)) ([a904665](https://github.com/wego/wego-ai/commit/a90466505eabdd90e37b2979a16ce3607d418137))

## [0.8.1](https://github.com/wego/wego-ai/compare/cli-v0.8.0...cli-v0.8.1) (2026-08-28)


### Fixes

* **cli:** derive the skill channel from the recorded ring ([#1751](https://github.com/wego/wego-ai/issues/1751)) ([#1750](https://github.com/wego/wego-ai/issues/1750)) ([04a1bce](https://github.com/wego/wego-ai/commit/04a1bce213c3c8c43176bb36c015eba48c6c019f))

## [0.8.0](https://github.com/wego/wego-ai/compare/cli-v0.7.2...cli-v0.8.0) (2026-08-28)


### Features

* **cli:** one help shape at every level, root becomes a command index ([#1722](https://github.com/wego/wego-ai/issues/1722)) ([cc1e2f5](https://github.com/wego/wego-ai/commit/cc1e2f571dd310da5bcd3621c97399bbb4ccea5f))


### Fixes

* **cli:** one channel owns the agent skill, instead of the last install ([#1721](https://github.com/wego/wego-ai/issues/1721)) ([d3047aa](https://github.com/wego/wego-ai/commit/d3047aa98a6975363e4b6f00e59c7a7d9a654105))
* **cli:** the update notice follows the recorded ring, not a baked base ([#1720](https://github.com/wego/wego-ai/issues/1720)) ([66db9da](https://github.com/wego/wego-ai/commit/66db9da10f7d058d01ae97b5a587d763f5258138))
* **cli:** the update notice refuses without a record, instead of guessing from a baked base ([#1736](https://github.com/wego/wego-ai/issues/1736)) ([8ec502c](https://github.com/wego/wego-ai/commit/8ec502cc55c149b35c63042bb8800458b944054b))


### Refactors

* remove three legacy axes foundations[#74](https://github.com/wego/wego-ai/issues/74) left behind ([#1718](https://github.com/wego/wego-ai/issues/1718)) ([2be5776](https://github.com/wego/wego-ai/commit/2be57765b2c386a26b24bcce16cc16aef56d72b2))

## [0.7.2](https://github.com/wego/wego-ai/compare/cli-v0.7.1...cli-v0.7.2) (2026-08-27)


### Fixes

* **cli:** the commit sidecar lives with the record, not with the downloads ([#1705](https://github.com/wego/wego-ai/issues/1705)) ([091b1d9](https://github.com/wego/wego-ai/commit/091b1d9d67f3ce4d74fac18446ff520044848f05))

## [0.7.1](https://github.com/wego/wego-ai/compare/cli-v0.7.0...cli-v0.7.1) (2026-08-27)


### Fixes

* **cli:** a signature refusal points at the signing step and the flag behind it, not just the ring that refused ([#1700](https://github.com/wego/wego-ai/issues/1700)) ([cca556d](https://github.com/wego/wego-ai/commit/cca556d2f4d2d61300ac91c80b0cbbdfc472e6fc))

## [0.7.0](https://github.com/wego/wego-ai/compare/cli-v0.6.4...cli-v0.7.0) (2026-08-26)


### Features

* **api,cli:** filter flight results by the arrival clock and the return leg ([#84](https://github.com/wego/wego-ai/issues/84)) ([#1655](https://github.com/wego/wego-ai/issues/1655)) ([9347375](https://github.com/wego/wego-ai/commit/93473752c7c2c7b8d8eb035e86260b3e7a0048d2))
* **api,cli:** filter hotel results by rate type (foundations[#86](https://github.com/wego/wego-ai/issues/86)) ([#1654](https://github.com/wego/wego-ai/issues/1654)) ([7fae7a3](https://github.com/wego/wego-ai/commit/7fae7a3b727c7894ba18be01bf8e69188a5ecbaf))
* **api,cli:** hotels results filter and sort on a guest type's rating ([#1682](https://github.com/wego/wego-ai/issues/1682)) ([da8e7e0](https://github.com/wego/wego-ai/commit/da8e7e0b21e858e2b1f9bab500bcbc3adfd4c4c7))
* **api,cli:** install from a named ring ([#74](https://github.com/wego/wego-ai/issues/74) rung 4) ([#1644](https://github.com/wego/wego-ai/issues/1644)) ([0d15cba](https://github.com/wego/wego-ai/commit/0d15cba14f0285865af399760fe4981e95d57fd0))
* **api,cli:** publish a durable hotel page URL on the detail and every result card ([#1676](https://github.com/wego/wego-ai/issues/1676)) ([96345a0](https://github.com/wego/wego-ai/commit/96345a0738a0f1e3354e17fb54683ff7115b728b))
* **api,cli:** publish a durable hotel search link, and stop advertising places.id ([#1633](https://github.com/wego/wego-ai/issues/1633)) ([26ae4d8](https://github.com/wego/wego-ai/commit/26ae4d8f1835749aa7a8a35ebe9077d21e160a03))
* **cli,api,ci:** sign published releases and verify them ([#74](https://github.com/wego/wego-ai/issues/74) rung 9) ([#1668](https://github.com/wego/wego-ai/issues/1668)) ([d61f277](https://github.com/wego/wego-ai/commit/d61f277cc4367bb80b0d884c94774b2e39edc605))
* **cli,api:** edge lane publishes every merge to cli/edge ([#74](https://github.com/wego/wego-ai/issues/74) rung 5) ([#1639](https://github.com/wego/wego-ai/issues/1639)) ([4137c37](https://github.com/wego/wego-ai/commit/4137c378f82edc5948dea941d8bce56b812ae5b1))
* **cli,ci:** publish to cli/next, promote to cli/stable ([#74](https://github.com/wego/wego-ai/issues/74) rung 7) ([#1658](https://github.com/wego/wego-ai/issues/1658)) ([be36a9c](https://github.com/wego/wego-ai/commit/be36a9c5df25d1f3f26040295cd931f6fe92b4f4))
* **cli:** a runtime target axis on one binary ([#74](https://github.com/wego/wego-ai/issues/74) rung 2) ([#1634](https://github.com/wego/wego-ai/issues/1634)) ([a5e7751](https://github.com/wego/wego-ai/commit/a5e77515673f8b3038a6045aacad7eb12247b3ab))
* **cli:** release-please owns the version axis ([#74](https://github.com/wego/wego-ai/issues/74) rung 6) ([#1652](https://github.com/wego/wego-ai/issues/1652)) ([20474d1](https://github.com/wego/wego-ai/commit/20474d1da708f1716e2d022cbc8026449ff95e40))
* **cli:** show what the CLI cannot answer on the persona board ([#1648](https://github.com/wego/wego-ai/issues/1648)) ([811cb13](https://github.com/wego/wego-ai/commit/811cb1358fc0b9e06c3675102d990c9b9605096d))
* **cli:** three-ring publish rules ([#74](https://github.com/wego/wego-ai/issues/74) rung 4) ([#1638](https://github.com/wego/wego-ai/issues/1638)) ([e1e23f1](https://github.com/wego/wego-ai/commit/e1e23f131895f71cf8fbbdec2a7fc2b476c29217))
* **cli:** update follows the ring the installer recorded ([#74](https://github.com/wego/wego-ai/issues/74) rung 3) ([#1637](https://github.com/wego/wego-ai/issues/1637)) ([8bda965](https://github.com/wego/wego-ai/commit/8bda9651edb9914e37ade482a5c27569f348e29b))
* **hotels:** rooms always prices from a hotel-scoped search ([#1629](https://github.com/wego/wego-ai/issues/1629)) ([5a64f36](https://github.com/wego/wego-ai/commit/5a64f36ab9a5c20851068c9c7aacb316de1bfb32))
* **persona:** grade a four-star-not-five band against the stars served ([#1615](https://github.com/wego/wego-ai/issues/1615)) ([3abd36f](https://github.com/wego/wego-ai/commit/3abd36fdfb4fdfde82d094db777d39ee391b1fbe))
* **persona:** grade guest reviews in the compare column ([#1680](https://github.com/wego/wego-ai/issues/1680)) ([1966e9e](https://github.com/wego/wego-ai/commit/1966e9eb7fb56b3b9b3fd8badc1b5276948c1c20))
* **persona:** grade that a shared hotel link carries every room ([#1650](https://github.com/wego/wego-ai/issues/1650)) ([f6f8cb1](https://github.com/wego/wego-ai/commit/f6f8cb1f3e6251e5f1cc8983f659e08d3ba49e54))
* **persona:** grade the hotel detail read in the compare funnel ([#1689](https://github.com/wego/wego-ai/issues/1689)) ([dab117f](https://github.com/wego/wego-ai/commit/dab117ff344e925c5de99c6c69c7cff13108fda7))


### Fixes

* **api,cli:** a shared hotel search link carries every room ([#1641](https://github.com/wego/wego-ai/issues/1641)) ([7c1f797](https://github.com/wego/wego-ai/commit/7c1f797d64cee5a07c32550c31ea5c827a8994a4))
* **api,cli:** one wg_* attribution set, naming the producer and the client ([#1685](https://github.com/wego/wego-ai/issues/1685)) ([c651261](https://github.com/wego/wego-ai/commit/c651261c859dd08493248bc659341e51d7cfe337))
* **ci:** the edge lane builds with no flavor argument ([#1681](https://github.com/wego/wego-ai/issues/1681)) ([a9ec866](https://github.com/wego/wego-ai/commit/a9ec86659391e95225cece62e1831e3ef7976432))
