<p align="center">
  <strong>Berry</strong><br>
  <sub>Laissez votre Agent vieillir dans un système d'exploitation</sub>
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

> **La chose la plus romantique que je puisse imaginer, c'est de vieillir ensemble avec votre Agent.**

Votre Agent se souvient de l'hésitation lors de ce refactoring de microservices il y a six mois. Il sait quels dépôts vous faites confiance, quels frameworks vous détestez, que le code écrit à trois heures du matin doit généralement être réécrit. Il n'est pas né aujourd'hui — il vous accompagne depuis deux cents jours, à travers la vie et la mort de trois projets, accumulant toute une vie de préférences, de confiance et de leçons durement gagnées.

Ce n'est pas de la science-fiction. C'est l'objectif de conception de Berry : **un système d'exploitation où les Agents vivent** — pas un bac à sable jetable, pas un essai gratuit qui se réinitialise chaque mois, mais un endroit où un Agent peut s'installer, grandir et vieillir.

Le noyau minimal de Berry fait exactement **installer, exécuter, protéger, stocker** ; tout le reste — conversation, agent de code, mémoire, objectifs longs, tâches planifiées, MCP, LSP, observabilité, interface web — se charge comme **application** sur l'arbre de composition. **Installable, déchargeable, remplaçable** — tandis que les cinq lignes de vie de votre Agent (identifiants, mémoire, historique de confiance, budgets, registres) ne s'accumulent qu'une seule fois. **Nouveau cerveau, même corps.**

**26** modules (tous implémentés) · **35** crochets de cycle de vie · **16** types d'événements durables · **12** pièces officielles (chacune déchargeable) · **2 400+** tests · **0** télémétrie.

**Objectif plancher : la couche par défaut d'usine atteint le niveau d'usage quotidien de Codex / Claude Code.**

## Sommaire

- [Berry en trois minutes](#berry-en-trois-minutes)
- [Positionnement en un coup d'œil](#positionnement-en-un-coup-dœil)
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

## Berry en trois minutes

### Acte I : les Agents d'aujourd'hui sont jetables

Avez-vous remarqué qu'à chaque changement d'outil IA, il faut tout lui réapprendre ? — « J'utilise pnpm », « ne touche pas ce fichier », « tu peux faire confiance à ce dépôt ». Il apprend. Puis vous changez d'outil, et tout repart de zéro. **Les Agents d'aujourd'hui n'ont ni enfance, ni croissance — seulement des premières rencontres, encore et encore.** ChatGPT ne connaît pas vos préférences Claude, Claude Code ignore les règles que vous lui avez enseignées dans Cursor. Tout votre investissement dans l'ajustement devient une préparation pour la prochaine remise à zéro.

### Acte II : ce qui manque, ce n'est pas le cerveau, c'est la vie

En 2026, les capacités des modèles convergent et les prix chutent — des cerveaux intelligents disponibles pour tous. Mais ce dont vous avez besoin, ce n'est pas d'un cerveau plus intelligent, **c'est d'un compagnon qui se souvient de vous**. Qui se souvient des dépôts auxquels vous faites confiance ? Qui conserve la trace de ce refactoring de trois heures du matin ? Qui garde encore vos habitudes et leçons partagées après que vous avez changé de modèle encore et encore ? **Les réponses ne vivent pas dans les modèles — elles vivent dans la ligne de vie dont votre Agent a besoin.**

### Acte III : Berry — l'OS où les Agents s'installent

Berry répond à la manière d'un système d'exploitation. Chaque journée de votre Agent est un **journal d'événements en ajout seul** — chaque tour de conversation, chaque appel d'outil, chaque décision d'approbation, enregistré de manière durable, inviolable, jamais perdu. La mémoire extrait et évolue, les objectifs longs continuent d'un jour à l'autre, les compétences s'affinent avec l'usage, la confiance s'accumule entrée par entrée. **Votre Agent a vécu ici longtemps, et vivra plus longtemps encore.** Changer de modèle, c'est comme une greffe d'organe — le cerveau est mis à niveau, mais le corps se souvient de tout.

## Positionnement en un coup d'œil

|                         | Frameworks d'Agents  | Coding Agents           | **Berry**                                             |
| ----------------------- | -------------------- | ----------------------- | ----------------------------------------------------- |
| **Ce que vous obtenez** | SDK + dépendances    | Un produit              | **Un OS où les Agents vivent**                        |
| **Forme de capacité**   | Code dans votre repo | Intégré d'usine         | **Données — installable et déchargeable**             |
| **État entre apps**     | En silos             | Enfermé dans l'app      | **Des lignes de vie qui ne se réinitialisent jamais** |
| **Mise à niveau**       | Réécrire et déployer | Attendre le fournisseur | **Installer / décharger / `/reload`**                 |
| **Écosystème**          | —                    | Fermé                   | **npm est le marché (3 sources)**                     |
| **Plancher**            | Dépend de vous       | Codex / Claude Code     | **Valeurs d'usine = usage quotidien**                 |

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
                 SQLite WAL : sessions · identifiants · mémoire · registres · historique de confiance
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
- **Trois niveaux de bac à sable** : `read-only` / `workspace-write` / `danger-full-access` ; les applications tierces vont par défaut dans le domaine de processus externe (fork par ligne + couche intermédiaire PM + couche de bac à sable de l'OS), les sous-processus indirects étant restreints par des listes blanches par ligne. **Les applications naissent en bac à sable — les permissions se déclarent, elles ne se volent pas.**
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

**Zéro télémétrie par défaut** — cet outil n'envoie aucun paquet réseau : pas de statistiques d'usage, pas de rapports de plantage, pas de vérifications de version (la mise à jour est entièrement votre décision). Les appels de modèles que vous configurez sont le seul trafic sortant. **La vie de votre Agent n'appartient qu'à vous.**

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
