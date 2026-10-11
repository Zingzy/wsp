// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { rootsPathIn } from "../project-path.js";

/** The content of every daemon this project has deployed, oldest first, one entry per version: the last one is
 * what a deploy installs today. No branch writes it: the landing runs scripts/cut-daemon-version.mjs, which appends
 * the sha of the tree it lands where the daemon changed, with the version and its note. An entry with no sha to
 * name is UNRECORDED: the three cut before the record existed, and the versions branches held before the cut. */
const UNRECORDED = "";
const DAEMON_CONTENTS = [
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "b749121a659b9c45b07285ee0f4e95f15aae26ddbc1bcba75745e83c2ae032c6",
  "b0b88a03c649769e0676ca38eaa5035825b71302c97a2858dcf8eb57131288be",
  "cae44a68bd72d81717b52a71c3890da918025cbd0d071db884102936e5cf4345",
  "c5c3b15cad1b45ed110b072a18d0d895f661c489f73828de78a3b9f3589f05c6",
  "f90fd16f8e5d15707cda18e58524da66fb6ed6b890632fff90d396792dc5604d",
  "9ebea6a49390fd5b1af911f413e77c3e46db091812b55b41515e881e93433292",
  "da0d618fd27965a77c8c15e389fea39c8f3ae691326af0212a8f1c62b9c8499f",
  "cbfe733de05765b706c3ff4d08aa62ee188258771dd3b02011633716fad62a48",
  "12eac7cd2f4b90f9064279a1ea3b3169d24e34c30279f5c19d046252e2d5ec66",
  "877eda4200afad3842bedad0e49d6efc942ef1ef3ea7181af22f9e726d72b669",
  "206d96d53b9734c3dce0e84bf11d5455e210b2419b6c9572748ebf69861afca5",
  "6875c912371aadfb9947191e4d887b9fb6576ed57d0268de91811a6d3ac4f4cd",
  "4c81908db0c4d29e74f00ddd5513e94137f01afeb39b9afbed242368be6097c6",
  "0ad3a1c3e98d5b75bf94d610b9e166a7ad1bb5e79ee7ab4905d6b738fb5eded9",
  "01030623497a43f044916ca27731dbfa4c92c6b82765a9e9dbd6426d69b1ee4e",
  "a6ae68d8af502a8a5ecf9795ca11ca0b9b12cda2792e45eee3376c7e4d57917b",
  "055dcf11b2a17e8959ab3a6246c2d17f89eb3837c59b31d3a8138c6dc7b6c322",
  "09e441a435678290871e210158d5f8fef3b43b307c5ec917086a201583c037a5",
  "386b54104e2a8abf8f45f9a35fe767971b72d5d00da68c4d8ae0aa9630b7cc6d",
  "9ff538bbfca0ac4e03ca8c822afd47b630dd21cec17ec929192ddc6ae6f10ce6",
  "14b4b9c0ccad20d544fa123841592c6438f735405f97a88957dafe4c39f47e8b",
  "ad9341f55ebc6a724a35b9febb11f7ca5cf5133a90d7a631bf39cf9a496657ac",
  "cebb929363226a20c057702cfe24235fa2f24749c70355539f5bab4b3bcfd3da",
  "bbdd3b1dc7fb73b04d5986128d099e11a723d777bd1a3c7cddd14819f1ee8cfc",
  "35236ee3220f12db35f3307812b2d2ea8c8762f8910e656d9d57a44bb599b0e3",
  "372241b199d0b23db89c2618409d8edf611bc5f29811fdaffca813ec2b283295",
  "5bb58cbade0b5be39242aa419feaa7e24d82a291271d6d83a2488799005fd5a0",
  "fdfbebe6ae5c0ff581df732222b76b6540a2e4d226c5381878e125499f55180c",
  "87e30b445d1e815a4dc336b35924ed061bc30374ad7f490ec3fefb4f194b6c0f",
  "e527369ddf63dcc38642a26caca0cd2f72f50e9be8b06f76d7cb7c93c349d826",
  "352699bc2434f5b1dc84d46026499662abf3bbcc4bc701736150a90042f79368",
  "0bec2f8329f6e46772d072acb082a83a943fe87ed31f2a83df3295069d1f6243",
  "5ef12ef8bf31cdb5ebbdd7ef56113fc447876b63dbabd073752a802491db5fab",
  "e0134bee72be55ed8349d11a9e656b61ee20ba55472be25546f0809763f99d9c",
  "9a92c0f6248b0182e5f5f7ad02c2d6e54b0809513171a390927d63bc3ee00e70",
  "46fe3b809d1bcc82d0dc644d8f300672cb72ae63c99668f6c1be1c75aa71a3f4",
  "87a461ca21eb894d129e0d692bcbdf56f1134d6160a0e84fe52692ed36f317cd",
  "8308517d14718d8b82e1e129f1e48a8a511aa9fdaae26b60c900b6280fa85051",
  "a51cf26e554a02935fda02942869ddd7251b41e84625e500336c7ce171a4d667",
  "c2f00944a79a850450b11b4610b93ac4894b7da39282755a9bfef55776a11dff",
  "c1fba7f2f77da32e75e8099b3ffd8bb36c0dbddfe88b0f018a2e59ac0e3b6905",
  "b9025a75a5b7f55164be73f60b2fd9f64510f74ad17d8fb24b18af168587899f",
  "022f1786d1aca054624bb042955dbbde64ecb4c974e918bbe95cf53e5d29cf0b",
  "e84a3a735fac175e251581fc61e29cd446e38142fb4579cae50cdaf30d63b858",
  "ed2fb414194ec877f031cb6a09e7869b4727132e25768eca2da581c8b902a0d1",
  "4453f856251c047172490b84c8502f74b6a1d25744f6878a382ac32fe45f2c46",
  "4605e734f4735405ddefd0478583032757ca8ad0b2dc8ce9a14e92789c2800a0",
  "52dc451ba47d583759687b0d9c8b5f3dc1d9f820ca25dc1e030e1268cc2b5157",
  "eb6eb2701b4edafd3f62e17ab032313660bafbfe80ce973bd56a56c86662aff8",
  "2b992e451cd69dbf08eac12f8c1208a1b01cf1a5a36319bc4875a08e387ae05f",
  "7deddf539fb438f49cc68e299e5d3e08413202f7325a73d7d815a532ac1e96c7",
  "1e3ca55474038b943e69a5a91ddf720df24e9f8a5fff8aa05028527cbb0605f2",
  "863d552bfaeeff40212778a4f175bf821f8ff5cdd7829e6922866bf70dcdbe5e",
  "376bdbce753a06ef57dfdda1e50f1cb761a728538dd85851db285168e4d1e568",
  "c1d414a8d13ee7070d1df56f82b7230bb53bed51b8b2d43c4bc39a864c5b5489",
  "cec7af13cc254d8325bf77409aedc4daeb072d5dc0413b58aaf45f8428698721",
  "b1c827b22fbdade28b749f72899b610723d5f312e339e9546552da14840013c1",
  "7324cbd1f27eb8983b8ea302c3cd32a629a4eedae7e0d46458acca37440baf88",
  "b83b671323ccc59fe9daa43da46dede2d640451c5b4f0c8e64ae2eef149ba694",
  "5b5db8f843457bfac71002bb4741d98f0f98bfe11579e7891c1a0955c39eed0f",
  "e10ddc035c5a0fb57b8b591da1fa220023e836e7c7598022c19d852e747bab46",
  "e6eb64e2466dfa2eca9448ea2aabfe82223c2897276663698a1184a16774145d",
  "361aa8997cc132755f0835ada745b05c7eee7faf20e67d14fa606971c5157441",
  "2c9896b832aebaccaf1b4f2c69ffba662e0a8b7f5748fc359313f8aff46a3b2a",
  "673d1f56aa3159a41d1b55b3b17c306628912a793cabc7d0208d2a4b937f07af",
  "311811170de5296b4e25d8b3bc6e46035a9c5fc13f6430d8ae9314be8d9815f9",
  "4202fe729182d82873c035271bb091be1fce798422a5349d9430e773567246a9",
  "dacb3a6c014686cff3aa977b424725f7270d200c3d42239b8467e94487593eb2",
  "4faf16035d8608562f0cfa8d463a7dc8b38830944b43002b9544697bb9c1dcd9",
  "83b228f3e824311abc08d0ff81538122bc5a0028655198ef6abba17f7daeaf0c",
  "ba2f7c6846cfc3d7ce66ff15f554d8b87dc20f5683931777d244e142709815dc",
  "de414be04f6f1b5142c2e5e718f4acd0a0526558dc96bed3a02b31f7acd924ba",
  "15f43fcf51b6d460b6e1acfa2ed0ce279a6645647834a10174bd9d249c2b2e6e",
  "7a1d4e70b470d3f404c987c4300756615bfca9f904f0ef12e74f26497775d72d",
  "c76e7e2a3b9a767beaa281b973a409e1bc8869969255fa6c9fdeb6211b38ce3d",
  "be3d9077764035f8bf2b96ab6b50c018017046ec74a30827404f64752ef19bdf",
  "837e923920b718c42e372f7d84dd08d4d51add8e7b86de1ab4afb4a156afb8ae",
  "69559f24eb63363f130e96d07548df1e6cffed939d08d5df760e5ac9948f240e",
  "4693a00a74c923f64a9062a65cac539d5ac7621da08fc623c63089a87b8231d7",
  "6064295b774d39defb1ba58ef099812ee1e4662bac2a1525c6d0061128450f2f",
  "12dc3a3741a25239969103531def3c28df0874e9233825d16f7063a84df345c6",
  "ca0a7c835985a42469446d3efd1e622568ef0772725ddf4700efc631038f6c1f",
  "11da9462eb0cc7aa26e3f05feed71e2e27774769026dfa6d7a4f3a08f6511ebb",
  "16e43173fadb40a741a588b14470f652528a4202fd434c2b9dc2702c7d78fc7c",
  "7e3fcbd460f842ff7343389c09ddbf43de751d83abea5cf82580d929811656e7",
  "e927a6944459d21c2598ce6ff7511bd6bb22eed9ac962aaedcce620e92b3d321",
  "1796fa8ef2dcd4c907e1314205bdca852b06c8fb807c5580b517c7ee389a188a",
  "fcbf00c4e8075aea8eec9513751ad6412db3feae36f2a1e78d2465eca51b86a4",
  "9468bfd7e5cd26a8458b328ef1f01634bbd12954c7b2d4dc13711adb7f19ae95",
  "17dc947dabc1776d901352d4d681af228e620309b8b4d8b8043ac9d904788bb4",
  "eb62eb296316d8c81da569e60be2c5db173b00f00a2ef7f562db39265db49423",
  "4d9cc489a1a3cbd2b502fa2f899bfddd5bf206ae00f1a2a76b9fa8dd7aef5f60",
  "5bc5f0d1888a8f254ffffa1bee6b77a302bf5c1164f520e5255b2f6c4a83a252",
  "db97f7d2dba5d48e19188ea89555803e76332015c7c2daf27a3a6c42d7f49cce",
  "297d0addb6e4b758e1f50a38516edc1eb32aa22da6894e5be52323d6b998c4fa",
  // 99 to 101 are held by daemon changes still in review, whose entries land with them.
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "fdfe7e8214a09e7c6e73ddea88aa9c167869ef0e02436b4c1ce7df85c7fdaa72",
  "4b81b5dc48a8d5472532d2c900a0247233533c19da9516bbb8ee2c17cfe4c9c1",
  "f2efbe27af183ea59d6f6875831f6263b013d6a179d94ba977075c5478172e5a",
  "66a2d192c8d56348d567f6cae3120df03a0022011f42b426be17d94238c8870f",
  "3cfade0dea7b54831d65ec361226fb95958f457ad08a3aa6003e67da5581ada8",
  "9a59b1daa92807a07d52f8d1ee0a3b3d3d5680202be1da20498b093b5b1daa71",
  "29eeb80d015c5099f6991b2acc3a0457f26aa1636b66f8751d6734cdb1a0639d",
  "ad16ee01ba69b4bd8339c8aa4753c2f3e46aa80c8d9f1ceeab9ca1038482f062",
  "409fce58696aaa20c7803f7a963841e4aacc0702a153ca6f916fba64f941bd16",
  "89e10a249a0e59670fc8fefec015f640d8f021d0b24bb34665412360cf6b999b",
  "ffcede69616fafe56cf56a3ec668d56516c22b7c9f53fc5176621c902ad7e639",
  "019c206265a45a72e87e3e436643cc96399b6ed44d5ae07de967b502e5742abc",
  "b423faeb3b4ae38a7456d11b877ab8720adaaa62650c5b33209ee24e02fb37b9",
  "4076321ab3d83fb3893ad81b9222fc36b92dccec81e8e9bc4566cc64a412b299",
  "81b16217319586241e368d7cb84fa0383a11b8d056a03053c700140422ff5e71",
  "2d3c09680f6c9dca01d8915f8d7be7306ba0db7fc6e1734353a86bf5afaa4e4e",
  "1557c21f49fe3ec9248ca8c405e450b0f201e9bc4fd3f552bfd0f36132272b17",
  "1ee653af3b44dc450246290cc7bb7617da6ec8f062d9e859452472019e52e51e",
  "1fb569928a97d7ba40fd54d251dc4202f267133344e7da3153f3f4aa723e180e",
  "c92b490e1481821bfdc26584e0f8b19e73e28fefeefeae6fb61c189ad098d88e",
  "a89600e669b83780c19582d096ed9c9a274446a75da14d185bc0afee9d299ba9",
  "9dc9610fb0581804589fcf952e0f5df34b029bbae2034ea135f420867b5b4c5c",
  "089d2b84fb314ca0fb7361046e327978a243aee796789f72cd5e2e8f8a71c191",
  "f9b9aedecc0b89b12571cea110ff89f317df4472af13de32ef2f5681334f46a7",
  "a9a90585446c8bd453c888fc716b3097631dbd87d7116d7f65a8a9a436df7352",
  "b704e47c6fcf966b5148ddb7d9e19ed17cddce96c9d70011e9367616d1226649",
  "31a6bcca711ff0e60f8953d4b8e5544bab64c3143c956122fc2a781a3a653a64",
  "2540fa408c276c18c468074087ba6a23d1c0607d2324b74db6ef7ff07ad89bd7",
  "7ce975e245d718211ba30c356b6fbc500fc2c9170924b46b974ae3f93e8f0508",
  "1597d4f2ea2cdebc749b7771600c6e7e0bd8138057410b65077314a06ed83ac6",
  "166b923c53261c003bd6f0fe2abcb934de3ded0b7a3406847208412bec65a6f1",
  "2fffa024e4e0dcf10bce9c6e88581cef388c2a6d66018c56cf859549133ef1b2",
  "55ddb7999b0cfdfc71b505a67752585dc97e1e74e47db1ab2d256573f577e5f3",
  "871dd3f376bcbde4e5f98c8d0777e75b0c36df1c81436b00c0749726d8122ccd",
  "664b32a5e3b463b18771d6a9f6938ea3f1312c96898a9951cb32a1ed15185ed0",
  "9790029ce878d8248fe04d470b8da1e4060b686480f088f0d9d79c7b76e7064d",
  "b97e864f4fecee0ea1c25a13b912025977cea507255a19045937e92ec826199c",
  "a536c66dad64f36710861cc4d1f377e4af59ec51ef4d982b89d67a5e0ccac65b",
  "5d6d78c548416aae6c65876d3499f0462c47fe2203c534982501a2eab32e7f94",
  "df80acbb03e838c04d4d2de65181fbd28ed47015cd41058773a07249fe883af7",
  "97757fce8a1af0f854aeebb94852334e4be7a749abd8b59d26482e51cb6f5f93",
  "f11092ebbda4c528bd4264ebe7e541e50941f573227f29a641a6c977b1281385",
  "30e5f5cfa31e466e2c1ef6c48698cfd4bca296363eb0a625c98d07edc7cdf017",
  "ec71770f7aa868a95bf5fa8e4c665b9b54d5f60b519763c39b7078db5a44dd0e",
  "2251d179bdc717c30bf018e9e5dd800c99a0d838d4dd664bf220a4c6a92ce4bb",
  "fb4c9130d2a267071ff4628ec8f9bfb49a3c10818f6894b3b44b5dbddacddf22",
];

/** The daemon's protocol version, carried in its hello, so a client can tell what a machine's daemon answers
 * before asking, and a host can tell that a machine's daemon is behind the one it would deploy. It moves whenever
 * an op is added or widened and whenever anything a deploy installs changes, because a live machine keeps the
 * daemon it has until the version it announces is behind this one. A hello without one is version 1: every daemon
 * deployed before the field existed, which has the pty, ports, manifest, inbox, fs, git and tunnel ops and no sys
 * or proc ops. Version 3 browses the imported project folders named in DAEMON_ROOTS_PATH beside its home.
 * Version 4 starts from a script that sets the guest PATH itself. Version 5 fetches its Node through the catalog's
 * curl function. Version 6 puts itself last for the kernel's memory killer and starts every shell it opens at the
 * work score instead. Version 7 picks the road to the listening ports by platform, so the same daemon serves them
 * on a Linux guest and on the person's own Mac. Version 8 runs under a systemd unit that restarts it, so a
 * daemon the kernel kills comes back on its own. Version 9 reads the utilisation and the processes it serves
 * through a module per kind of machine, and answers a watch only once that module has read the machine, so a
 * pane is refused where it would otherwise wait for a stream that never comes. Version 10 keeps a DISPLAY the
 * caller names on a pty it opens, so a sign-in whose page must return to the machine can be handed a browser to
 * find there. Version 11 serves a machine reached over ssh, which reads the load and the processes of the machine
 * it runs on the way a fork does; the same daemon under the person's own login there, with every path it keeps
 * under their home. Version 12 asks the prefix it would compile against for the headers themselves, so a machine
 * where an installer symlinked a foreign node into that prefix builds node-pty instead of failing on it. Version
 * 13 asks those headers which major they are and compiles against them only when the node that will load the
 * result agrees, so an older Node's headers left in the prefix send node-gyp after the right ones instead of
 * building against the API another Node declared. Version 14 reads the environment a provider could not hand a
 * fork at create off a file under /etc the unit may lack, so a backend that lands it there hands the daemon its
 * keys without touching anything else on the machine. Version 15 is deployed by a script whose guards end it
 * themselves, so a machine with no service manager and an npm install that failed stop at the line that found
 * them instead of leaving the rest to run. Version 16 starts by the node the deploy compiled its native modules
 * under, kept in the daemon's own folder, rather than by whatever a PATH the machine owns names at the moment of
 * the start: a machine restored onto another one names a different node there, or none, and none is a start that
 * fails every second for the life of the machine. Version 17 answers an exec op and can dial a host of its own: a
 * computer somebody joined as a place opens the socket outward, proves itself on the ed25519 key that host learned
 * at the join, and then serves that socket exactly as it serves an inbound one, so every command the host already
 * sends a machine rides one frame on the link and no runtime road learns a second transport. It also loads its
 * native pty module at the first terminal rather than at its own import, so a machine where nothing built that
 * module serves every other op instead of refusing to start. Version 18 finds that native module where a packaged
 * command carries it: the command bundles node-pty rather than requiring it, and a bundled CommonJS module arrives
 * with a default export and no named one, so a daemon running inside the packaged command opened no terminal at
 * all until this. Version 20 takes every option as a flag,
 * one per option, reads its ports, load, processes and pty modes off one /proc root, logs its samplers' starts and
 * stops, and builds a place's report and sweep off the home it is pointed at, so a test suite drives it as a binary
 * and the words and numbers it answers with are the protocol's, held in one fixture set. Version 21 takes
 * --runtime-root, where a place's daemon keeps the layers and the workspaces it runs itself. Version 22 is one
 * static binary, built from the Rust sources under daemon/ for each chip a machine can be: the deploy lands the two
 * Linux builds and keeps the one uname names, the unit and the supervisor start it by its path with one set of
 * flags, a computer joined as a place runs the same binary under its login's own manager, this computer's
 * workspace spawns it, and the guest keeps no node, no npm install and no native module for the daemon; the wsp
 * command beside it still runs on the node the machine carries. The binary also answers a plain HTTP request 426,
 * as the host's status probe reads a daemon by. Version 23 commits a workspace's upper directory to the layer store
 * as a snapshot, names a snapshot's chain as a template, and naps a workspace by stopping it: the processes go,
 * the upper directory stays as the saved layer, and the wake boots it again on the same address and forwards.
 * Version 24 makes the daemon the workspace manager on a joined computer: its report says whether it runs
 * workspaces here rather than whether it holds a Docker, and the install writes the wsp-workspace AppArmor profile
 * where the box takes it, so what a deploy leaves for a workspace to isolate under changed. Version 25 serves a
 * fenced engine socket into a workspace that asked for one: a proxy over the box's own Docker or podman socket that
 * labels every create with the workspace, filters every listing by it, refuses what would reach the box, and joins
 * a container's published port to the workspace's loopback; a create names the socket with the new engine field.
 * Version 26 stops a build whose libseccomp is not linked statically, so the Linux daemon is one static binary that
 * names no shared library; a binary that did was installed once and its container init called address zero.
 * Version 27 answers machine.snapshot with a job and machine.snapshotJob with how far it has got, so a layer that
 * takes minutes to write waits on no one frame; the layer is a plain tar, the shape carries the bytes the workspace
 * wrote, and a snapshot's failure is the job's own refusal. Version 28 runs every exec behind the workspace's
 * seccomp filter: a process an exec started ran with none while the init ran behind one, and now loads the same
 * filter before its command, or the exec is refused. Version 29 keeps one form per layer on a box: the unpacked
 * tree forks mount, with the blob dropped once its unpack is whole, so an image costs its size once; a layer's
 * bytes in a snapshot row, an image row and the swept count are what the tree's files hold, and the sweep at the
 * daemon's start drops any blob it finds beside its tree. Version 30 asks a machine for the service manager its
 * daemon would be held up by before a byte lands on it, rather than inside the install: the deploy script carries
 * that check no longer, and a machine wsp did not build is turned away with nothing written on it. Version 31 lets a
 * place say which life a copy may be taken from: a provider whose snapshot is the disk as it stands answers
 * snapshotsAnyLife and a builder that woke there is sealed, where one that answers only its first life still refuses
 * after a restart. Version 32 holds every workspace on a computer somebody keeps to a size that leaves that
 * computer a core and the smaller of half its memory and a gigabyte, a spec that names no size included: the
 * create answers the size it gave and one sentence saying so, the record holds that size, and the capacity says
 * what the workspaces there hold of the computer. Version 33 answers a client on the computer itself the listing of
 * the workspaces it holds and one reading of any of them, both read-only and both on the road that dials in; the
 * reading carries the sizes as applied, the memory and processor time off the cgroup, the uptime, the process
 * count, the address and the two paths, where the metrics op before it read two of those and replied with none.
 * Version 34 takes the daemon its host deploys over the link it already holds, where a computer once kept whatever
 * daemon it joined on: the parts of the binary arrive under one upload id with the sha256 of the whole, the last is
 * checked against it, moved over the file the unit starts with the old one kept beside it, and answered, and the
 * agent then ends so its supervisor starts what landed. Nothing is swept, so the workspaces' records stay on the
 * box and the daemon that comes up reads them again. Version 35 carries the daemon binary in the bundle where the
 * wsp command riding beside it reads one, under that command's own assets and one folder per chip, and writes the
 * unit, the supervisor script and the AppArmor profile inside the arm for the chip the machine says it is: the
 * binary a machine runs and the one a computer's own join looks for are one file, at one path, under one rule.
 * Version 36 relays a guest session: a process inside the machine opens one on the daemon over loopback with the
 * daemon's own token, and the daemon carries it up the socket the host already holds, so the wsp an agent runs
 * there needs no address of this host, no TLS and no node. The binary answers that word itself, and the deploy
 * writes a two-line shim onto the machine's PATH, in the same arm as the unit, that hands it the line.
 * Version 37 answers no op differently: the contract fixture a reply is held to no longer names a provider nothing
 * can serve, and a fixture's bytes are in the sha whatever they say. Version 38 answers nothing new either: this
 * record holds every Rust source under crates, test code included, so two cases added beside the place link's
 * agent parsing and the pty's cwd move it while the binary a guest runs is the one version 37 named.
 * Version 39 holds a joined computer out of idle sleep no longer: the hold that watched the place file is gone and
 * the file carries no field for it, so a computer sleeps on its own schedule while it is joined.
 * Version 40 dials a host at an https address: the link turns one into wss as the protocol does and speaks TLS
 * through rustls with the root certificates baked into the binary, since a box may carry no certificate store of
 * its own. It is the one road to a host that sits on a laptop behind a home router, which is the first address
 * such a host writes into every place file, and until now the link refused it and the box never dialled back.
 * Version 41 is the same binary as version 40: what this record hashes changed, not what a deploy installs. A
 * crate's tests/ folder is out of the sha, so test-only work stops cutting a version and no machine reads itself
 * as behind over cases it would never run.
 * Version 42 holds a guest session open across a host that went: the daemon keeps the frame each session opened
 * with and names every session it holds to whatever socket asks to watch next, so a host that restarted picks them
 * back up instead of closing the first message it cannot place, and a session nobody has watched for ten minutes
 * ends to its guest with one sentence, so the process inside the machine prints it and exits rather than waiting
 * for the life of the workspace.
 * Version 43 names the run of the daemon that opened a guest session: every opened frame carries a marker minted
 * once per start, so the host tells a session it still holds from a session of the same name on a machine that
 * was rebuilt under it, whose names count from the start again. Without it a guest carrying no turn token, running
 * the same line from the same folder under the same token, was glued to the earlier session's output.
 * Version 44 gives a workspace on a computer you own its project as a copy made once for it: a btrfs snapshot where
 * the checkout is a subvolume, a reflink copy where the disk shares blocks, a plain copy everywhere else with its
 * time said in the create's notice, chosen by asking the disk and never by a filesystem's name or id, bound into the
 * workspace at the project's own path before the runtime starts and unmounted deepest first at stop. The place report
 * carries the word for what the computer's disk can do, so the computers row says it. Before this a workspace shared
 * its project through an overlay whose lower directory the box could change under it, which the kernel leaves
 * undefined.
 * Version 45 lets a machine specification name shares: files the computer keeps outside every workspace under the
 * daemon's logins directory and binds into each workspace at a target path, so a login signed in once on the computer
 * is the same file in every workspace there and a refresh in one is the computer's refresh; a share whose source sits
 * outside that directory is refused at create.
 * Version 46 makes a workspace on a computer you own out of the computer itself: its system directories under overlays
 * with an upper per workspace, its home shared read-write with the daemon's own files hidden, the engine's data
 * hidden, the project bound at its path; a box pulls no image and keeps no layer store, and the snapshot and template
 * operations leave its wire. The root moves to /wsp so no upper sits under a lower the kernel would refuse.
 * Version 47 adds the copy verb the Mac host runs as a child: a directory clone of a project folder at a sibling path
 * in one call, a git worktree where a clone cannot work, then the two rules that make the copy a clean checkout with
 * its ignored files kept; the capabilities say whether a computer copies and whether a copy gets its own network,
 * which is how the row knows this Mac shares ports.
 * Version 48 lets a machine specification name binds: folders on the computer bound into a workspace at create,
 * read-write or read-only, refused where the source is not a directory on the computer; the runtime binds a project's
 * memory folder this way so every workspace of the project on that computer reads and writes the one memory, keyed on
 * the project and not on a path.
 * Version 49 makes a workspace on a box awake or stopped and nothing else: pause stops it with SIGTERM to its cgroup
 * after a real quiet window read off its published ports and its commands, and the reading carries how long it has
 * been quiet; a service bound to loopback inside answers through the published port; a create the box has no room for
 * is refused in one sentence naming the quietest workspace; root inside drops the standard capability list and sees
 * empty files over the box's secrets, its ssh keys and the engine's paths; the compose project is named per workspace.
 * Version 50 adds the git road out of a workspace: a push of the branch the copy is on with a refusal to push the
 * base, the pull request opened or found through the signed-in host command line on the computer and its state read
 * back, three operations behind one trait with one module per host.
 * Version 51 gives a workspace on a box the box's tools and a daemon that answers for it: the box's Homebrew prefix and
 * every install root the recipe lands outside the overlaid trees are bound read-only into the workspace's rootfs, and the
 * place daemon serves a workspace's git, file and exec operations with the workspace's checkout as the working directory,
 * so nothing runs a daemon inside a workspace and the init's supervisor lookup is gone.
 * Version 52 refuses a bind whose destination is one of the trees the rootfs takes from the computer, the box's /root
 * and every shared tool root whether present on the computer yet or not, or sits under one, at the create, so a
 * workspace's copy or folder bind can never leave its mount point on the computer's own home.
 * Version 53 puts the provision folder and wsp's own folder whole on the list a leave sweeps, in the daemon and in the
 * protocol with a fixture that holds the two equal, and reads the landed list before the folder goes so wsp's own landed
 * files leave with it and the folders they emptied are pruned; a bring back reports its push half first, the branch, the
 * ahead count and the diffstat, and a gh that is present but not signed in reads as the note beside the landed push,
 * while a push refused for want of a credential says so in the person's words with the command only the person can run.
 * Version 54 adds two optional fields to the place report: each agent's version as the daemon read it, and the relative paths of the files under the logins directory. A host on 53 reads a 54 report as before; a 53 daemon's report reads on a 54 host as today, with no version and no sign-in word.
 * Version 55 reads the agents it reports, and their versions, on the tools PATH the workspaces and the presence read use
 * before the unit's own, so an agent installed by Homebrew or by its own installer is on the report; and the boot records
 * the computer's own paths of the mount points it made for file shares under the computer's trees, so the stop and the
 * remove take them off when no other running workspace shares the target and nothing of a workspace's mounts stays on
 * the computer's own home.
 * Version 56 writes the mount points a boot makes into the create's own claim before anything is mounted, and the record
 * carries them at the end, so a create that fails between the point and its record leaves the points to the open's sweep
 * of unfinished claims and nothing of a workspace's mounts stays on the computer's own home.
 * Version 57 reads the mount points a neighbouring boot has claimed and not yet recorded, so two workspaces sharing one
 * login that boot at the same moment both own its point and the last one to go takes it off, and writes every record,
 * claim and network file to a sibling and renames it into place, so a daemon that dies inside a write leaves no torn
 * file for the next open to refuse, which takes a dead create's torn claim away instead.
 * Version 58 writes the process manifest to a sibling and renames it into place through the same writer every file the
 * runtime crate writes takes, so a daemon that dies inside the write leaves the manifest it had or none, never a torn
 * one the next start refuses.
 * Version 59 binds a socket in each running workspace's own wsp folder that answers a guest's ping, open and send and no
 * other op, so a process inside a box workspace reaches the host's guest door without a token of the box's, writes the
 * wsp word into the workspace's own upper, and opens a shell inside a workspace's namespaces for the terminal pane, held
 * beside the daemon's own ptys and answered to no other workspace.
 * Version 60 links only to a host it has proven, taking the second frame after the first is verified and its own prove
 * sent, seals every frame of the link at both ends so whoever carries it reads and writes nothing, resolves no command
 * through a folder a workspace can write, and holds a token of its own machine's rather than one every machine shares.
 * Version 61 bounds the guest bytes in flight per workspace on a place and per daemon inside a fork, queued and unsent
 * alike, and refuses a frame past the cap with a sentence of its own while the session stays open.
 * Version 62 prints its two kernel knob lines only on Linux and nothing on a Mac start, closes the guest door of a
 * workspace whose init died on its own by watching the init's pidfd and running the stop road, and stops redialling
 * a host that refused its place under a signature over the pinned key.
 * Version 63 counts the bytes a client buffers behind the WebSocket upgrade against the same pre-auth cap as the
 * bytes after it, so nothing rides the upgrade past the door unweighed.
 * Version 64 opens every path under a workspace's rootfs beneath it by descriptor with no link followed, covers the box
 * root's startup files with the workspace's own copies, lets a workspace read under /etc, /var and /srv only what an
 * allowlist names, and skips a linked row at the copy's exclude rather than removing outside the copy.
 * Version 65 fences the engine socket byte by byte: the client-to-engine copy is bounded to the framed body, a volume
 * names no box path, a volume attaches only to the workspace that made it, the bind allowlist lives where a workspace
 * cannot write and every source resolves beneath the rootfs, an engine container joins a per-workspace network, and
 * the daemon's and the engine's ports are closed at the gateway.
 * Version 66 makes every bind under a workspace's rootfs receive-only through a descriptor reopened after the bind,
 * so a workspace on a box boots again: versions 64 and 65 refused every create with EINVAL at the shared home's bind.
 * Version 67 gives a workspace's pty and exec on a box the recipe's knobs and a PATH with the prefix's bin ahead of
 * the home's, so a thread runs the tools the recipe put under the prefix rather than the old copies under the home.
 * Version 68 names, in a pane's create reply, the process its pid is, so a reader of the workspace's pty knows which
 * environment that pid carries; the pane's shell starts from the workspace's own environment as before.
 * Version 69 keeps the fence's connection to the engine open until the engine answers, so a forwarded request is
 * never cancelled into a bodiless 499, and lets a workspace on a box with a refusing input chain dial its own box.
 * Version 70 counts a workspace's sessions and connections at its socket and measures a frame before parsing it, so
 * one workspace cannot run its box daemon out of memory, and the leave removes its owned files by directory handle.
 * Version 72 drops a copied folder's worktree records before the copy's checkout, so a copy of a repo whose base
 * branch one of its own worktrees holds lands on that branch.
 * Version 73 answers fs.folders, one level of a box's folders or every repo on it, for a project added from a box.
 * Version 74 removes a directory clone by renaming it to a hidden sibling and removing that in a process of its own,
 * so a delete answers at once, sweeps any such sibling a stop cut short at start and on the next copy made or
 * removed beside that project, and refuses to remove a path that is not a copy of the project it names.
 * Version 75 takes back what a failed ssh add put on a box: before the add lands anything it asks which of its paths already exist, and after a failed deploy it removes only what this add wrote, stops a unit this add started, and leaves the box as it found it when another add took it meanwhile.
 * Version 76 answers as 75 does: a directory clone's removal takes the copy's own path off the shape check, and a test pins that a path with a trailing slash sets aside the link it names.
 * Version 77 forwards a guest's `wsp mcp` to the running host over the daemon's link, so a thread's MCP server needs no host process of its own on the machine.
 * Version 78 changes no behaviour: the pty broker's cases moved to a test binary of their own, and the file they left is hashed.
 * Version 79 changes no behaviour: every wire type in the protocol crate derives the TypeScript the protocol package re-exports, which moves the crate's sources and the lock.
 * Version 80 answers git.status on a stopped workspace with the branch alone, read off its copy's git directory with no program run, and says the edits were not read; running or stopped, a branch with no upstream counts ahead and behind against the default branch; a stopped copy's history too long or slow to walk answers countsUnknown.
 * Version 81 reads no record another daemon wrote: a workspace record carries every field and a points file that does
 * not parse is refused by its path; the hello always names the version; the copy verb has no in-place road and the
 * daemon no ssh kind; exec and pty take the compose project off the workspace's own boot environment.
 * Version 82 changes nothing a guest runs: the binary gains the mcp verb behind a feature the guest build leaves off.
 * Version 83 answers fs.search: the files under a folder whose path holds a query's letters in order, or the lines of text there that hold it, walked with the folder's ignore rules and never through a link, under a cap and a time budget.
 * Version 84 adds fs.files, every file of a checkout git would show, from git ls-files and kept until a folder holding one
 * of them changes, and git.prList, the repository's open pull requests and issues through the host's command line, an
 * empty list with a note where that command line is not there or nobody signed it in.
 * Version 85 adds git.checkpoint, a turn's whole tree recorded as a commit outside every branch under
 * refs/wsp/checkpoints/<copy>/<thread>/<turn>, and git.restore, which puts the tree back to one of the copy's own
 * checkpoints after recording the tree as it stood; a worktree copy's removal deletes its checkpoint refs.
 * Version 86 writes into a copy: git.commit commits the files named with the message on stdin, git.discard puts one
 * file back as HEAD has it, and fs.write replaces a file's contents whole; git.diff gains the head scope with untracked
 * files as new, paths, whole files in one hunk, and each file's blob id; a discard takes the folders it left empty, and
 * the binary's version verb prints this number.
 * Version 87 changes no behaviour: the place link's seal moved into a crate of its own, which the tool server's dial
 * to a host somewhere else links too, so the crate's sources and the lock moved.
 * Version 88 lists untracked files in git.diff's branch scope as well as its head scope, over the whole repository
 * from any folder, and an untracked link with no patch and no blob rather than a diff read through it; a repository
 * whose top sits above the daemon's root answers git.diff for the files under that root alone.
 * Version 89 changes nothing a guest runs: the forwarder on the host's computer no longer asks the wsp where the host
 * is, a wsp mcp line that names its state is served by the binary's own tool server, and the guest's tool server
 * session drops the reopening only that forwarder did.
 * Version 90 reads a pull request with the repository named off the remote the frame carries: git.prRead answers one by
 * branch or number with its checks, review, mergeability, counts and how far its base has moved on, and a read by
 * number that gh refused is an error rather than none; git.prView its page with the comments on its lines, git.runLog
 * a failed job's last lines, git.repoRead a repository's merge methods, and git.prMerge merges only the head it names;
 * git.update merges the base's latest commits into a clean checkout and takes a conflicting merge back; git.pr answers
 * the whole fact, and git.prState is gone.
 * Version 91 adds git.snapshot, the checkout as it stands as one commit on HEAD taken through an index of its own,
 * and git.range, the diff between two such commits by their full shas, held to the daemon's root as git.diff is;
 * every git.diff file gains its kind and its line counts, and a checkpoint starts no fsmonitor.
 * Version 92 opens a new listener on the reading that finds it and asks it once, beside the reading, whether it is a
 * browser's DevTools port; one that answers as one closes on the next reading and is left out of every one after.
 * Version 93 starts an ssh server for an editor: ssh.start writes the one key it is handed as the only authorized key,
 * starts the image's own sshd on a free loopback port inside the workspace (inside the fork where it names a
 * machine) and answers that port and the server's host key; tunnel.open names the machine it dials inside, and
 * tunnel.data and tunnel.end carry it back. The server and every process it started are stopped five minutes after
 * its last tunnel closes, and when the daemon ends; one an ended daemon left behind goes before another starts. A
 * daemon answering for a computer somebody owns starts none on that computer itself, and inside a workspace the
 * server's files are written with no link of the workspace's followed.
 * Version 94 asks the DevTools question on the person's own computer only of a listener wsp's own processes hold, the
 * daemon and everything under the host that started it, so no other server of theirs gets a request from wsp.
 * Version 95 is the deploy landing each file of the bundle by a rename over the one it replaces, so a daemon that is
 * running is replaced rather than refused as a busy file.
 * Version 96 reads every worktree file git.diff answers for itself, from the folder the caller may read down with no
 * link followed: an untracked file's patch and every file's blob id come from that read, and a tracked file's hunk is
 * diffed from the base object and the blob hashed off that read, so no content byte comes from a path a link could
 * have redirected after git listed it.
 * Version 97 changes nothing a guest runs: where this computer's binary carries the tool server, the host runs it for
 * each guest session as the thread's scoped server under --guest, which refuses a file or an unnamed workspace and
 * leaves the tools that read this computer off its list.
 * Version 98 runs the command pty.create names through the person's own shell, as interactive and login as their
 * terminal opens it, and the pty exits with it; such a pty is a reply's, which pty.list marks and no pane adopts, until
 * pty.tab hands it to the panes still running.
 * Version 102 hashes an untracked file's blob id in this daemon's own process, in the repository's object format,
 * from the bytes it read, so a checkout of tens of thousands of untracked files spawns no git and writes no object;
 * git hash-object is run, with -w, only for the tracked hunks git.diff rebuilds from the object.
 * Version 103 asks the DevTools question only of a listener whose holder goes by a browser's or Electron's name
 * (Chrome and its helpers, Chromium, headless_shell, Edge, Brave, Arc, Electron and its helpers), so a node server a
 * thread's tests start gets no request. It reverses the rule of version 92, which asked every listener by what it
 * answers, on the owner's ruling.
 * Version 104: git.startOn puts a checkout on a branch as the remote holds it, git.branchCompare counts a branch
 * against a base branch or commit through the git host's command line on this computer, and git.mergeIn merges a
 * child's branch in with a merge commit and answers with the child's commit it took, fetched from the remote or from a
 * copy's folder on this computer under overrides that stop a served repository's configured commands. A fetch or a push
 * refused for want of a credential carries the code no-git-credential.
 * Version 105: Reads a pull request's author and last-updated time and each commit's author from the one gh page read,
 * so the pane's header names who opened it and when it last moved and each commit names who wrote it.
 * Version 106: Changes nothing a guest runs: a leave run as root takes the workspace profile the daemon's options name,
 * the one a root install writes unless a test names a file under its own home.
 * Version 107: Starts and reviews from a link: git.issueRead reads an issue, git.prCheckout puts a copy on a pull
 * request's head through the host's command line, git.prDiff reads a diff cut on a file's boundary, and git.prReview
 * posts one review whole with a comment outside the diff put into its body. A pull request read names its author and
 * its fork, a bring back pushes where the branch's own configuration points, and git.pr fills under a title or a body
 * given.
 * Version 108: the daemon keeps its computer's readings, one point a minute folded from its samples, in a file a day
 * beside its token or in the folder --readings-dir names, 14 days under 8 MiB with the oldest day dropped first, and
 * sys.history answers them folded into the step asked for.
 * Version 109: A turn's changed-files range is now what the agent itself changed: each commit it wrote contributes its
 * own files, collected one by one over the turn's reflog window whatever moved HEAD after them, together with the edits
 * standing in its end worktree and the files it resolved by hand in a merge, while a HEAD move it did not write (a
 * checkout, pull, merge, rebase or reset) is named on a line with no files of its own. A rebase is one such line plus
 * the edits standing at the end; the commits it replayed and any conflict it resolved mid-rebase are not listed.
 * Version 110: A joined Mac reports which Mac it is: its place report carries the product name its registry gives, else
 * its model identifier, so the computer's row draws that Mac rather than a server. git.status counts the stashes a
 * repository holds, running or stopped, so a delete names them.
 * Version 111: the room check's refusal is a contract word, so the Mac's copy road says the same sentence.
 * Version 112: A pull request's page reads when it opened and settled, who merged it into which commit, its labels, the
 * reviews asked for, each reviewer's latest verdict and its assignees; each commit's message body and, off one GraphQL
 * read over gh's own first 100 commits, its parents, line counts and rolled-up checks, the newest 100 reviews' ids and
 * whether each of the newest 100 threads is resolved, with a mark for each part read only in part; every page of its
 * conversation and its line comments off the REST API, with each author's association with the repository, whether a
 * bot wrote each comment and the face it shows, and each line comment's hunk, the comment it answers and its review. No
 * body on the page is cut, and every host line's answer is read to 16 MB and refused past it. A check reads when it
 * started and finished, a pull request the merge armed on it, and git.prDiff cuts at the bytes asked for, up to the cap
 * a git.diff has, reading at most four times that before it stops gh and names the files it saw.
 * Version 113: Writes on a pull request as the person signed in to gh: git.prReply posts a reply under a comment on a
 * line or a new comment in the conversation, its body as typed on stdin and at most 65,536 characters, a line reply
 * carrying back the thread it names; git.prResolve resolves or unresolves a review thread; and git.prReact adds or
 * takes off a reaction. A resolve and a reaction name their thread or item by a node id, refused before anything runs
 * where it is not one's shape, and refused before the mutation where a read finds it on any pull request but the
 * repository's one numbered. A pull request's page reads each comment's, review's and line comment's node id and
 * reactions, with whether the signed-in person left each, and each line comment's review thread by id.
 * Version 114: The binary makes and removes the worktree a thread on another branch works in: copy worktree answers the
 * worktree already holding the branch, else makes one under the host's folder (or the project volume's own .wsp) on the
 * branch as its tip stands, a new branch at the folder's HEAD and never a reset, with the folder's config files and
 * each named dependency directory carried in by one clonefile per directory; copy worktree-remove takes away only a
 * worktree wsp made, refuses one holding uncommitted files unless forced, and saves a detached worktree's commit to a
 * refs/rescue ref first. git.checkpoint and git.restore take a scope that names the refs in place of the folder, and a
 * thread keeps its newest hundred checkpoint refs, the before refs a restore writes counted; git.checkpointDrop takes
 * one thread's refs away; git.worktrees and git.branches read a repository's worktrees and its local branches;
 * git.switchNew puts a folder on a new branch with its changes carried along; git.fetchBranch fetches one branch of a
 * remote into a local branch, moving it only forward.
 * Version 115: Daemon port-file test times out on Linux CI about half the time.
 * Version 116: recipes and the add-a-computer setup job.
 * Version 117: A leave run as root takes wsp's install folder, /opt/wsp, off the computer with every link in
 * /usr/local/bin pointing under it, and nothing else of either; a prefix that is itself a link stays and is said.
 * Version 118: A leave run as root first takes what the setup wrote under /usr/local and /opt, read off the list in
 * /opt/wsp: each path still as wsp left it, hashed in one pass, a folder once empty, and nothing the computer had
 * before wsp; the list goes last, and while it still holds lines /opt/wsp stays and the leave says so.
 * Version 119: setup sign-ins, cut syncs and the size check survive their edges.
 * Version 120: git.prRead asks a pull request named by number with what its last read saw (its last update, head commit
 * and state): one REST read compares them, and where none moved it answers unchanged with nothing else run and none of
 * the GraphQL budget spent; a read with nothing seen makes no such read. A read the git host refused for its rate limit
 * carries the code rate-limited, and a branch so refused never reads as having no pull request. git.prView reads the
 * page on one GraphQL call in place of four, the newest 100 conversation comments with the rest marked cut.
 * Version 121: leave tests take a temp install root, never /opt/wsp.
 * Version 122: A turn's HEAD move lines name the branch HEAD was on: git.snapshot stamps the branch it stands on, or a
 * detached HEAD, beside the reflog length, and git.turn reads the turn's window back from that stamp, so a merge reads
 * "Merged origin/main into fix/x", a reset "Reset fix/x to origin/main", a pull "Pulled into fix/x" and a rebase
 * "Rebased fix/x onto main", one that was detached says "a detached HEAD", and a pull that rebases is one line.
 * Version 123: an agent-owned live panel per thread.
 * Version 124: restore three landings a later squash took back out.
 * Version 125: ports.watch takes roots and a folder and reads every five seconds, only while a socket watches. A socket
 * that names roots sees the listeners of their process groups, every process under them and every process running in
 * the folder; a watch that names none, the host's own, sees the whole machine. Each socket is told what moved against
 * what it was last sent, a port another holder took as a close and an open, a port that left the view while it still
 * listens as a close marked left, and a second watch names its roots again. A browser.open with no port hurries the
 * watch to a read a second through the spotter's window. proc.watch sends one whole proc.snapshot two seconds after the
 * watch and then a proc.changes every five seconds; every frame carries a seq and each proc.changes the base it applies
 * to, and a socket that watches again is sent a whole snapshot next.
 * Version 126: six small host and test faults.
 * Version 127: The daemon's ssh start picks a free port, lets it go, and races another process for it.
 * Version 128: remove takes back only what the add made outside the home.
 * Version 129: hold the ports a test counts on being refused.
 * Version 130: git lines put a separator before every name a checkout or a frame chose, a push and a fetch no longer
 * read a branch named as a flag, and a pane's save, a terminal's size file and a door's mode go through a folder's
 * descriptor.
 * Version 131: the contract fixtures and the daemon's tests name the repo wsp-labs/wsp; nothing the daemon does
 * changed.
 * Version 132: a copy road's refusal writes a size as the app does (512 B, 21 GB, 1.3 GB) and a thread's cost groups
 * thousands and rounds 1.005 to $1.01 as the app does, both held to one case file the TypeScript twins read too.
 * Version 133: reap sshd on exit and empty a leave's folders by fd.
 * Version 134: usage.logs reads the agent stores the host names under the home the daemon serves (Claude Code's
 * transcripts, Codex's rollouts, OpenCode's database) and answers each session's tokens per half hour under one model
 * and folder, and the newest plan reading a Codex rollout kept, for the host alone: the inbound socket of a daemon that
 * is no place and the link of one that is. What each file came to is kept for the daemon's life.
 * Version 135: An agent's version read tries its spawn again while the binary reads text file busy, inside the read's
 * own deadline, so a binary another process still holds open for writing gives its version line instead of none.
 * Version 136: A computer you joined binds a socket in wsp's folder under the login's home and writes a wsp in the
 * place's own folder there, never the person's own wsp in ~/.wsp/bin, that runs the new wsp-door verb on that socket
 * and nothing else, so a thread running on that computer itself opens its wsp sessions there and its link carries them
 * up named to no workspace, and a door that is missing is refused in one sentence rather than dialled around on the
 * loopback port: it names the systemd unit to restart where the daemon runs in the system unit the join writes, and
 * otherwise says to add the computer again. Its report says whether that door stands, why not, and that unit, the leave
 * and a failed add name the socket and the wsp, and a socket or a block device is no longer read as a folder by the
 * leave or by a container's bind staging. ports.watch takes a name, so one socket holds a watch per name with roots, a
 * folder and cgroups of its own, and each port event says which watch it is for; a process row carries the cgroup v2
 * path it stands in.
 * Version 137: shells read apart, panel ptys never reach the drawer.
 * Version 138: A leave takes wsp's own folder only once it is empty, and names the manifest, the put folder, the
 * readings, the sshd folder, the add's place-found.part and join code, and the folder a project's install logs go to
 * instead, so the person's own wsp and a host's state on the same login stay.
 * Version 139: copy worktree takes each ecosystem as a --module (its lockfiles, what it carries, what it never does and
 * where its install records the lockfile it installed from), counts a module in each folder of a new worktree holding
 * its lockfile where the project folder holds one of its directories there, and at the top for a module that carries
 * nothing, carries its directories in, mounts on a Linux disk that shares no blocks an overlay of a frozen copy of the
 * folder's directory made once per install where the daemon may mount and copies plainly once where it may not, and a
 * reflink copy on a disk that does, and answers fresh and each module it found with its folder and whether its install
 * runs; copy worktree-mount mounts a worktree's overlays again after a restart, one remount at a time, never over a
 * folder that holds anything and never through a link, every folder handed to the kernel opened with no link followed;
 * copy worktree-remove takes every mount inside a worktree down before git forgets it and refuses over one it did not
 * make; copy worktree-forget takes a project's frozen copies and its folder away, under the host's folder where the
 * project folder is gone, and a removal drops every set but the newest once no worktree sits on it.
 * Version 140: the daemon's tests and clippy pass on a Mac.
 * Version 141: A root leave takes the runtime folder whole unless the add found it standing, something is mounted under
 * it or the mount table cannot be read, and stops before anything goes, unless force, where a workspace's copy or a
 * project checkout there holds commits no remote has or edits it cannot read; `wsp-daemon unsaved <root>` prints that
 * same read, counts a branch whose name is not UTF-8 and no commit a tag alone keeps, follows a link in a checkout's
 * git folder that stays inside the checkout, and exits 1 where a folder of the runtime's cannot be listed, and reads
 * nothing on a computer that is not Linux, whose runtime boots no workspace; the place report says whether the leave
 * would take the runtime folder, and the daemon version the wsp it was started with says it was built with, read off
 * `<wsp> --version --json`.
 * Version 142: A push measured against a base the caller named, as a fork names its lead's branch, refuses the branch
 * the copy's remote starts every copy on with the code on-default-branch, and git.status answers that branch as
 * defaultBranch off the same read, origin/HEAD by the branch's own name, else a main or a master here, so the host and
 * the daemon call one branch the default.
 * Version 143: verbs, tools and the skill take a thread, not a workspace.
 * Version 144: fs.image reads a slate's image by its whole path, anywhere on the computer or inside the workspace it
 * names with no link followed there, opened without blocking and judged on the handle, and answers its size, modified
 * time, inode and change time with its bytes only where it is a regular file under the image cap whose own bytes name
 * an image type the protocol allows, and says svg where an SVG document stands there; a folder, device, pipe or socket
 * is refused not-a-file and a missing path not-found.
 * Version 145: A workspace's stop and remove take its child cgroups and every stacked set of mounts, a boot clears a
 * set a failed stop left, a remove deletes nothing while anything is mounted under it, place.leave takes the project
 * folders the host names, a leave over a /wsp that stood before the add takes only wsp's own folders there, and wsp's
 * empty cgroups go.
 * Version 146: fs.hash hashes the files a slate's command names inside its folder, each where it lands on this computer
 * or inside a workspace's root with no link followed, a regular file under the hash cap, so an Always on a command that
 * runs there pins the script and asks again once it changes.
 * Version 147: transcripts.list reads the Claude Code transcripts under a store root the host names, in the project
 * folders it names, off the first and last 64 KB of each file, and answers each conversation whose first recorded cwd
 * is one the host names with its title, first prompt, branch, entrypoint, mtime and size; transcripts.read walks one
 * session's transcript from its newest last prompt back through each line's parent, subagent lines left out, and
 * answers its newest messages with how many came before them. Both open every name under the store with no link
 * followed, as the home's owner. */
export const DAEMON_VERSION = DAEMON_CONTENTS.length;

/** sha256 of what a deploy installs on a guest and this record can hold: the Rust sources and manifests the binary
 * is built from, the lock that pins its dependencies, the C library the Linux builds link and its pinned release,
 * the contract fixtures its words and numbers are held to (the version itself left out of them, since it is this
 * record), the scripts the host writes beside it, DAEMON_ROOTS_PATH and the work-score line. The host's
 * daemon-content test recomputes it and fails when that content moved and this record did not, so changed content
 * cannot reach nobody: a start script gained a PATH line under an unchanged version once and every machine already
 * running kept the old one. Left out: every file under a crate's tests/ folder, which is built for a test run
 * and no deploy installs, so test-only work cuts no version for a binary nobody's machine would read as new; an
 * inline #[cfg(test)] module stays hashed, since the file carrying it ships. Left out too: crates/wsp-mcp, the tool
 * server a feature links into the host's own build and the guest build never does; the rest of this file,
 * which the binary reads only through the fixtures; hashing the protocol whole would turn every edit to it into a
 * redeploy of every machine. */
export const DAEMON_CONTENT_SHA = DAEMON_CONTENTS[DAEMON_CONTENTS.length - 1]!;

/** The file on the guest naming the imported project folders, one absolute path per line: the runtime writes it
 * when a project lands, the daemon reads it on every files and diff op and browses those folders beside its home.
 * The guest's home is /root, so this is rootsPathIn answered there; the value is hashed into DAEMON_CONTENT_SHA. */
export const DAEMON_ROOTS_PATH = rootsPathIn("/root");

/** The shape the records in a state file are written in. Any change to the schema of a stored record cuts this
 * number, and a host refuses a file in any other shape rather than reading a record in a form it does not know.
 * 2 since a project's seeded row changed whole: one word for what its memory did where it held two flags, the
 * memory folder's own file count beside it, and `bytes` now the sum the menu showed for the ticked files where it
 * was the size of the archive they travelled in, which is bigger, so the two numbers do not compare. */
export const STATE_SHAPE = 2;

/** What a save records about the wsp that wrote the file, apart from the records themselves: the shape those
 * records are in, the build that wrote them and when. A file with none was written before this record existed. */
export const StateShape = z.object({
  shape: z.number().int(),
  /** What the build calls itself: the version a released wsp prints, or the program's own name where it has none,
   * which is what a person would have to run again. */
  wsp: z.string(),
  /** The daemon that wsp deploys, which is the other half of what a build is. */
  daemon: z.number().int(),
  /** The binary it ran from, which is the one thing that says which of the builds on this computer wrote the file. */
  bin: z.string(),
  at: z.string(),
});
export type StateShape = z.infer<typeof StateShape>;

/** How a sentence names the build that wrote a state file. */
export const stateWriterWords = (wrote: StateShape): string => `${wrote.bin} (wsp ${wrote.wsp}, daemon ${wrote.daemon})`;

/** The one word a place's row says while this wsp deploys a newer daemon than that computer runs, and nothing
 * while it is level or ahead or has never reported. Both sides of the figure are already on the wire: the place
 * sends its own version in every report and this host's is the record above, so nothing is asked for it. Read by
 * `wsp places`, by the places table and by the doctor, so the three cannot word it three ways. */
export function placeDaemonBehind(place: { daemonVersion?: number }): string | undefined {
  const version = place.daemonVersion;
  return version === undefined || version >= DAEMON_VERSION ? undefined : `daemon ${version}, host ${DAEMON_VERSION}`;
}

/** The first daemon that answers fs.folders. */
export const FS_FOLDERS_DAEMON_VERSION = 73;

/** The first daemon whose checkpoints record the HEAD they were taken on and whose copy worktree takes --checkpoint,
 * which a fork onto a new branch needs. */
export const FORK_BRANCH_DAEMON_VERSION = DAEMON_VERSION;

/** The first build whose `wsp leave` takes --yes and --force, asks off a terminal without --yes, and takes the
 * runtime's folder. A gate written as this build's own daemon is pinned to its number by the landing's cut. */
export const LEAVE_ASKS_DAEMON_VERSION = 141;

/** Whether the `wsp leave` a computer runs is that build or later, read off the version its own wsp says it was built
 * with and never its daemon's: an update moves the daemon alone. A wsp that said none runs an older leave. */
export const leaveAsks = (report: { wspDaemonVersion?: number }): boolean => (report.wspDaemonVersion ?? 0) >= LEAVE_ASKS_DAEMON_VERSION;

/** The first build whose `wsp leave` takes `--takes`, the project folders under the runtime's folder the host's records
 * name, read off the version that computer's own wsp says it was built with, as `leaveAsks` reads it. */
export const LEAVE_TAKES_DAEMON_VERSION = 145;

/** Whether the `wsp leave` a computer runs takes `--takes`. */
export const leaveTakes = (report: { wspDaemonVersion?: number }): boolean => (report.wspDaemonVersion ?? 0) >= LEAVE_TAKES_DAEMON_VERSION;

/** The line that moves a place onto this wsp's daemon, which is the fix half of every sentence about a place that
 * is behind. */
export const placeUpdateLine = (name: string): string => `wsp add ${name} --update`;

/** What the doctor says about one place that is behind: the word above and the line that answers it. */
export const placeBehindLine = (name: string, word: string): string => `${name} is behind: ${word}; ${placeUpdateLine(name)} puts this wsp's daemon on it`;

/** The refusal an update gets on a place already running the daemon this wsp deploys. */
export const placeCurrentLine = (name: string, version: number): string => `${name} already runs daemon ${version}, which is the one this wsp deploys`;
