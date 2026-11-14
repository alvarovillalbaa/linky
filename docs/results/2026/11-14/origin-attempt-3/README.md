# First complete protected-resource browser pass

[Run43636473455](https://github.com/alvarovillalbaa/linky/actions/runs/43636473455),
source d319bfc41107d985f497fd26c474099dea097dc9, tree
e4d69e935d8d98a991efd2641428ed7f9d8c62f1 (100 tracked files/1107385B).
All four desktop/narrow Chromium156.0.8078.4 journeys pass with real PG17 and
two local HTTPS origins.27 unit and22 database cases are carried with verified
inputs from their preceding passes. No closed V1/V2 suite was replayed.

Seven80B downloaded attachments were byte-checked against authored content,
SHA2567ae07e0b83e719717eb613fc162da98f713cd66db9f2be9286b06f0b7766aef7.
The private host configuration was explicitly downloaded, parsed in private
scratch, installed only into the fixture guard and removed. No raw credential
is published. Screenshots are masked where secret fields could exist.

All four screenshots were inspected. They exposed two presentation concerns:
the original remaining-use display stayed stale after redemption, and replacing
controls after a download lost focus, exposing the skip link over narrow facts.
The next small UI correction clears the stale count to Inspect again and restores
action focus after asynchronous replacement. These observations justify repeating
only the four affected browser journeys, with explicit assertions for both.

Seven contexts, browser group, HTTPS server, pool/admin and private scratch closed;
all owned installations/certificates were removed. No page errors or unexpected
origins were recorded. Source before/after and every compressed stream digest,
all seven downloads and four screenshot hashes were verified.
Receipt SHA2565acebe23bc31425dbbd907cf4500857d888c3add599710d089a4588aab6de949.
Artifact14130475380 was487975B, provider ZIP digest
sha256:54ce0837167499abcda20ac62c060ea0e6e7d01ed964b2f584ea7f71657763b5;
archive-byte verification is not claimed. Live binding remains unverified.
