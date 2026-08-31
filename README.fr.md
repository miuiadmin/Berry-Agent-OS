<p align="center">
  <strong>Berry</strong><br>
  Le système d'exploitation des applications IA
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berryagent"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <strong>Français</strong>
</p>

---

Le noyau de Berry fait exactement quatre choses — **installer, exécuter, protéger, stocker** — et tout le reste s'installe comme une application sur l'arbre de composition. Les modèles et les outils changent chaque mois ; vos identifiants, votre mémoire, votre historique de confiance, vos budgets et vos registres ne s'accumulent qu'une seule fois. Berry conserve ces cinq éléments d'état opérateur, et chaque application que vous installez grandit sur le même état — la suivante reprend simplement là où la précédente s'est arrêtée.

Les applications prennent trois formes selon l'axe des types : **applications (lancées) / extensions (invoquées) / services (consommés)** — même l'expérience du premier démarrage ne réside pas dans le noyau : le réglage usine par défaut est l'application d'agent de code **coder** (assemblée purement par manifeste), l'application de conversation officielle `chat` servant d'ancre de repli. La double auto-évolution (évolution d'usage + évolution de compétences) suit la voie émergente : pas de planificateur central, le noyau ne fournit que des primitives.

**Objectif plancher : la couche par défaut d'usine atteint le niveau d'usage quotidien de Codex / Claude Code.**

**26** modules (tous implémentés) · **35** crochets de cycle de vie · **16** types d'événements durables · **12** pièces officielles (chacune déchargeable) · **2 400+** tests · **0** télémétrie.

## Sommaire

- [Pourquoi Berry](#pourquoi-berry)
- [Démarrage rapide](#démarrage-rapide)
- [Caractéristiques en un coup d'œil](#caractéristiques-en-un-coup-dœil)
- [L'architecture en un coup d'œil](#larchitecture-en-un-coup-dœil)
- [Tout est une application](#tout-est-une-application)
- [Modèle de sécurité](#modèle-de-sécurité)
- [Documentation](#documentation)
- [Ce que Berry n'est pas](#ce-que-berry-nest-pas)
- [État du projet](#état-du-projet)
- [Télémétrie](#télémétrie)
- [Contribuer](#contribuer)
- [Licence](#licence)

---

## Pourquoi Berry

Le véritable actif d'une application IA n'est pas le modèle — les modèles changent chaque mois — c'est **l'état opérateur** : identifiants, mémoire, historique de confiance, budgets, registres. Aujourd'hui vous utilisez une application de conversation, demain un agent de code, après-demain une application de nettoyage de données. Elles devraient toutes grandir sur le même état au lieu de repartir de zéro à chaque fois.

Berry répond à cette question à la manière d'un système d'exploitation :

- **Noyau minimal** : le noyau fixe fait quatre choses — installer (chargement des applications et du contexte), exécuter (boucle d'agent), protéger (sécurité et approbations), stocker (sessions et identifiants). 25 modules dans un DAG de dépendances unidirectionnel, verrouillé par des portes machine — le noyau ne peut pas être déchargé et ses responsabilités ne peuvent pas gonfler.
- **Tout est une application** : la conversation est une application, l'agent de code est une application, la mémoire est une application — même le pont MCP et l'interface web sont des applications. Les applications s'installent, se déchargent et se remplacent ; retirez n'importe laquelle et la boucle centrale continue de tourner.
- **Sessions fondées sur les événements** : une conversation est un journal d'événements en ajout seul (SQLite WAL) ; l'historique du modèle est une projection du journal. Masquage, bifurcation, récupération et relecture reposent tous sur la sémantique du journal — votre historique est votre donnée.

## L'architecture en un coup d'œil

```text
            ┌─────────────────────────────────────────────┐
            │  Noyau fixe (Ring 0) : installer · exécuter │
            │  · protéger · stocker — DAG unidirectionnel │
            │  de 25 modules, verrouillé par machine      │
            └──────────────────┬──────────────────────────┘
                               │ arbre de composition (couche par défaut + overlay.yaml)
        ┌──────────┬──────────┼──────────────┬───────────┐
        ▼          ▼          ▼              ▼           ▼
     coder       chat      memory         goal      …12 pièces
   (app par     (conver-  (état          (objectifs (chacune
    défaut)     sation)    opérateur)     longs)   déchargeable)
        └──────────┴──────────┴──────────────┴───────────┘
                               │ événements (journal append-only = source de vérité)
                               ▼
                 SQLite WAL : sessions · identifiants · mémoire · registres
```

## Démarrage rapide

```bash
# Nécessite Node.js >= 22.19
git clone <ce dépôt> && cd berry
npm install
npm run build
npm link          # installe la commande berry

berry             # TUI interactif (entre par défaut dans l'app coder, reprend la dernière session du répertoire courant)
berry run "hi"    # exécution unique (le code de sortie est le résultat)
berry dump-config # diagnostic de la composition effective (modèle / arbre / état de chargement, aucune écriture en base)
```

Le premier lancement crée le répertoire de données dans `~/.berry/`. Le modèle par défaut est `anthropic/claude-sonnet-5`, remplaçable via `APP_MODEL` ; les identifiants des fournisseurs passent par la chaîne d'identifiants pi-ai (variables d'environnement ou coffre d'identifiants).

## Caractéristiques en un coup d'œil

- **Noyau minimal (Ring 0)** : 25 modules dans un DAG unidirectionnel, tous implémentés, surveillés par `npm run lint:topology` — rien de central au-delà d'installer/exécuter/protéger/stocker.
- **Sessions fondées sur les événements** : journal d'événements en ajout seul + projections dérivées ; compactage des longues conversations (`compaction`), restauration par instantanés de l'espace de travail (`checkpoint` /rewind), bifurcation et adoption de sessions — le tout porté par le journal.
- **Ensemble officiel (Ring 2, chaque pièce déchargeable)** : `coder` (application d'agent de code par défaut), `chat` (application de conversation), `memory` (mémoire : extraction/fusion/injection double voie/recherche inter-sessions/évolution d'utilité/TTL/chaînes de versions), `subagent` (délégation de sous-agents), `goal` (machine à états d'objectifs longs + frein budgétaire + réveil par horloge), `scheduler` (tâches planifiées `/tick` — enregistreur launchd/crontab, sans processus résident), `mcp` (pont client MCP), `lsp` (pont de serveurs de langage : diagnostics/symboles/définitions/références), `web` (outil fetch + hygiène SSRF), `obs` (observabilité : agrégats horaires + `obs_query` + vue d'ensemble `/obs` + alertes), `admin` (outils d'administration de la plateforme), `webui` (interface web en loopback, ouverture ponctuelle par `--port`).
- **Pile de sécurité intégrée** : pipeline d'outils en trois étapes (validation de schéma → porte → exécution), trois niveaux de bac à sable (read-only / workspace-write / danger-full-access, macOS seatbelt / Linux bwrap), dérivation des racines inscriptibles et carve-outs, paires d'approbation, allowlist (approbation automatique auditée).
- **Système de compétences** : SKILL.md à deux couches + divulgation progressive — déposez un répertoire et cela fonctionne ; les applications peuvent embarquer des compétences dans leur paquet.
- **Chargement par arbre de composition** : couche par défaut + `overlay.yaml` avec surcharge au niveau des champs ; surface de chargement type centre d'applications — installation/montage en deux états, deux portées (globale / par application), rechargement à chaud par zone via `/reload --app`, et bac à sable de processus par défaut pour les lignes tierces.

## Tout est une application

Le chargement suit le **modèle de centre d'applications** : une application est un installable indépendant (les trois sources de npm sont le marché — noms du registre / git / répertoires locaux ; pas de boutique propriétaire), et l'installation seule ne change rien — installer la dépose dans l'entrepôt ; monter écrit la ligne de composition qui l'active. Les pièces officielles se montent en portée globale pour servir toutes les applications (l'état opérateur, comme la mémoire, grandit sur une base partagée) ; les pièces tierces se montent par application (l'autorisation et le rayon d'impact suivent l'application hôte).

Écrire une application pour Berry ne demande qu'un `index.ts` : un `apply(ctx, config)` exporté par défaut, des métadonnées déclaratives (dépendances inject, schéma de config, vocabulaire d'événements), et tout enregistrement passe par `ctx.effect` — le déroulement de la portée désenregistre automatiquement. 35 crochets de cycle de vie couvrent six couches (session / agent / tour / message / pipeline d'outils / fournisseur), avec toute la surface d'observation et de gouvernance ouverte. Consultez le [Guide de développement d'applications](docs/应用开发指南.md) (en chinois).

## Modèle de sécurité

- **Pipeline en trois étapes** : validation de schéma → porte (décisions d'approbation / bac à sable / allowlist) → exécution — la seule voie légale d'exécution des outils, registre durable sans contournement.
- **Trois niveaux de bac à sable** : `read-only` / `workspace-write` / `danger-full-access` ; les applications tierces vont par défaut dans le domaine de processus externe (fork par ligne + couche intermédiaire PM + couche de bac à sable de l'OS), les sous-processus indirects étant restreints par des listes blanches par ligne.
- **Paires d'approbation** : chaque action en écriture laisse une paire d'audit `approval/asked` / `approval/decided` ; le « toujours autoriser » passe par l'allowlist, énumérable et révocable.
- **Application du vocabulaire** : le registre du vocabulaire d'événements est vérifié par machine — les noms mal orthographiés échouent bruyamment, et les mots du noyau ne peuvent pas être falsifiés par des tiers.

## Documentation

| Document                                     | Contenu                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [docs/架构总览.md](docs/架构总览.md)         | Modèle en anneaux, DAG de modules, événements, montage           |
| [docs/使用指南.md](docs/使用指南.md)         | Commandes CLI/TUI, répertoire de données, variables, compétences |
| [docs/应用开发指南.md](docs/应用开发指南.md) | Forme d'entry.ts, services inject, crochets, composition         |
| [docs/开发指南.md](docs/开发指南.md)         | Quatre portes, discipline de test, frontières de modules         |
| [docs/运维手册.md](docs/运维手册.md)         | Données, sauvegardes, remise à zéro, protections, diagnostic     |

> La documentation fait actuellement autorité en chinois ; les versions dans d'autres langues sont prévues avec la version 1.0.

## Ce que Berry n'est pas

- **Pas un framework d'agents de plus** — un framework vous donne un SDK pour écrire du code ; Berry vous donne une surface de chargement pour installer des applications. Les pièces de capacité sont des données (installables, déchargeables, remplaçables), pas des dépendances de votre projet.
- **Pas un service cloud résident** — la forme monoposte va par défaut sans port ni écoute ; l'interface web est une pièce en loopback ouverte ponctuellement via `--port`, et la forme démon est un choix explicite.
- **Aucune promesse d'autonomie** — paires d'approbation, freins budgétaires, une allowlist énumérable et révocable : l'autorité d'écriture reste aux humains et aux registres, et chaque fragment de pouvoir reçu par le modèle a une surface d'audit.
- **Pas de second format d'écosystème** — les applications sont des paquets npm (distribution trois sources), les compétences sont des répertoires SKILL.md, la configuration est overlay.yaml : pas de boutique propriétaire, pas de format de conteneur propriétaire.

## État du projet

`1.0.0-alpha` — fenêtre de prépublication : les API, le vocabulaire et les surfaces de types évoluent librement ; les changements cassants arrivent en commits atomiques uniques. La recherche, l'exécution de commandes, l'accès web, MCP, LSP et l'observabilité (agrégats + alertes) sont implémentés ; la forme serveur multi-locataires est différée jusqu'à ce que la demande réelle la tire.

## Télémétrie

**Zéro télémétrie par défaut** — cet outil n'envoie aucun paquet réseau : pas de statistiques d'usage, pas de rapports de plantage, pas de vérifications de version (la mise à jour est entièrement votre décision). Les appels de modèles que vous configurez sont le seul trafic sortant.

Si un quelconque rapport est un jour introduit, quatre promesses s'appliquent : annonce préalable (Why this exists / How it works / What data is collected / How to disable it — les quatre sections avant publication), désactivé par défaut (inverser la valeur par défaut est un changement cassant), un interrupteur d'extinction vérifiable par machine (pas une promesse), et des données minimales (ce qui peut rester hors ligne reste hors ligne).

## Contribuer

```bash
npm run dev               # TUI (tsx, journaux au niveau debug par défaut)
npm test                  # suite de tests complète
npm run typecheck         # tsc --noEmit, deux passes
npm run lint:topology     # portes DAG de modules + vocabulaire d'événements
npm run format:check      # Prettier
```

Les quatre portes au vert sont la condition préalable de chaque commit. Voir [CONTRIBUTING.md](CONTRIBUTING.md) (en chinois).

## Licence

[MIT](LICENSE) — les pièces officielles sont distribuées avec le paquet ; les applications et compétences tierces portent leurs propres licences.
