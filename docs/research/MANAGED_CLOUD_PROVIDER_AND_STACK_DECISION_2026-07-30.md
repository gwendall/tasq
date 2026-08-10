# Décision provider et stack pour le premier Tasq Managed Cloud

> Note de recherche, 2026-07-30. Les sources externes sont limitées aux
> documentations officielles des fournisseurs, de Kubernetes et de SQLite.
> Cette note est une recommandation de décision : elle ne modifie aucun contrat
> Tasq, n'autorise aucun déploiement et ne ferme aucune gate externe.

## Décision exécutive

Choisir **Google Cloud** pour la première beta privée Tasq Managed Cloud, avec
une architecture Europe-first :

- région active : `europe-west9` (Paris) ;
- région de reprise : `europe-west1` (Belgique) ;
- runtime : **GKE Autopilot régional**, pas Cloud Run ;
- métadonnées du control plane beta : **SQLite mono-writer** sur un second
  Persistent Disk régional ; ne pas introduire PostgreSQL avant la beta ;
- ledgers Tasq Server : **SQLite mono-writer**, un `StatefulSet` par tenant et
  un Persistent Disk `pd-balanced` régional en `ReadWriteOncePod` ;
- secrets : **Secret Manager**, réplication gérée par l'utilisateur à Paris et
  en Belgique ;
- identité humaine : **Google Identity Platform**, tenant-aware, avec Google,
  email et OIDC entreprise, TOTP obligatoire pour les opérateurs ;
- identité des workloads GCP : **Workload Identity Federation for GKE**, sans
  clé JSON longue durée ;
- registry : **GHCR par digest reste l'autorité de l'image Server** ;
  Artifact Registry en multi-région `europe` contient les images privées et
  peut recevoir un miroir non-autoritatif, vérifié sans rebuild ;
- livraison : **Cloud Deploy** vers staging puis production, approbation
  manuelle obligatoire pour production ;
- exposition : Global External Application Load Balancer, certificat géré,
  Cloud Armor et une origine HTTPS canonique ;
- observabilité : Cloud Logging, Managed Service for Prometheus, Cloud
  Monitoring, uptime checks et alerting ;
- sauvegarde ledger : backup applicatif Tasq toutes les heures au lancement,
  envoyé dans un bucket Cloud Storage dual-region Paris/Belgique avec rétention
  verrouillée ;
- effets distants : désactivés.

La décision PostgreSQL est : **pas dans la première beta**. La cible ultérieure
est Cloud SQL PostgreSQL 18 pour le control plane multi-instance, puis
éventuellement pour le Server si les mesures le justifient. Ce port est
déclenché par la charge ou le coût, pas un prérequis au premier déploiement.

## Pourquoi la stack ne peut pas être « Cloud Run + PostgreSQL » aujourd'hui

Le dépôt impose trois réalités :

1. `TasqServerConfig` accepte uniquement des URL SQLite absolues `file:` pour
   l'authority store, le ledger et les receipts
   ([source](../../packages/tasq-server/src/config.ts)).
2. Le backup/restore Server repose sur `PRAGMA wal_checkpoint` et
   `VACUUM INTO`
   ([source](../../packages/tasq-server/src/backup.ts)).
3. Le control plane utilise actuellement `@libsql/client`, des PRAGMA SQLite et
   un schéma SQLite
   ([source](../../packages/tasq-cloud-control-plane/src/index.ts)).

Cloud Run fournit un système de fichiers en mémoire qui ne persiste pas à
l'arrêt d'une instance. Il peut monter un filesystem réseau, mais SQLite WAL
exige que tous les processus accédant à la base soient sur le même hôte et
n'est pas compatible avec un filesystem réseau
([Cloud Run, container runtime contract](https://docs.cloud.google.com/run/docs/container-contract),
[SQLite, WAL](https://sqlite.org/wal.html),
[SQLite over a network](https://sqlite.org/useovernet.html)).

Conséquence : mettre l'image actuelle sur Cloud Run provoquerait soit une perte
de données au remplacement de l'instance, soit un modèle de stockage que SQLite
déconseille. Un service accessible n'aurait donc aucune valeur de preuve de
production.

GKE prend en charge les applications stateful, les `StatefulSet`, les PVC et
les Persistent Disks durables. Un Persistent Disk régional est répliqué
synchroniquement entre deux zones d'une même région
([GKE, stateful applications](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/stateful-apps),
[GKE, regional Persistent Disk](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/persistent-volumes/regional-pd),
[Compute Engine, synchronous disk replication](https://docs.cloud.google.com/compute/docs/disks/about-regional-persistent-disk)).

## Architecture retenue

```text
Internet
   |
Global External Application Load Balancer + TLS + Cloud Armor
   |
   +-- /auth, /console, /cloud API
   |      GKE StatefulSet: host Cloud BFF / control plane (1 replica)
   |          |
   |          +-- Identity Platform
   |          +-- Regional pd-balanced: cloud-control.sqlite
   |          +-- Secret Manager
   |
   +-- /v1, /mcp, Server-backed Console routes
          GKE StatefulSet: 1 Tasq Server replica par tenant
              |
              +-- Regional pd-balanced, RWOP
                    authority.sqlite
                    workspace-*.sqlite
                    receipts-*.sqlite

Paris active
   |
   +-- backups Tasq digestés -------------------> bucket dual-region
   +-- Cloud Deploy manifests ------------------> cluster GKE DR précréé
```

### Un Server par tenant

Le Server possède un `hostTenantId` et peut contenir plusieurs workspaces pour
ce tenant. La première topologie doit donc être :

- un `StatefulSet` d'une réplique par tenant ;
- un PVC de 20 Gio par tenant, extensible mais jamais rétréci ;
- un fichier authority, puis deux fichiers par workspace, tous sur le même
  volume ;
- aucune seconde réplique Server pour le même volume ;
- `podManagementPolicy` et rollout configurés pour arrêter l'ancien writer
  avant de démarrer le nouveau ;
- `ReadWriteOncePod`, qui limite le montage read-write à un seul Pod, et
  `persistentVolumeReclaimPolicy: Retain`.

GKE documente que `ReadWriteOnce` limite l'écriture à un nœud, alors que
`ReadWriteOncePod` la limite à un seul Pod ; ce second mode correspond mieux à
l'invariant Tasq mono-writer
([GKE, Persistent Volume access modes](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/persistent-volumes),
[Kubernetes, ReadWriteOncePod](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-access-mode-readwriteoncepod/)).

Le Stateful HA Operator peut automatiser le détachement et le rattachement sûr
d'un Persistent Disk régional lors d'une panne de nœud ou de zone. Il ne crée
pas un second writer et ne protège pas d'une panne de région
([GKE, Stateful HA Operator](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/stateful-ha)).

### PostgreSQL pour le control plane

Avant le déploiement, il faut ajouter au package Cloud control plane un adapter
PostgreSQL explicite. Il doit préserver :

- les opérations idempotentes et leurs IDs stables ;
- les transactions de mutation et l'audit dans la même transaction ;
- la sérialisation des admissions concurrentes de quota ;
- l'isolation tenant ;
- l'horloge injectée ;
- les références opaques et les digests de secrets ;
- une suite hostile équivalente à la certification SQLite.

Ce port est borné au package Cloud et à son BFF. Il ne doit pas modifier le
format 29 des ledgers, Core ou les procédures de migration et récupération
TQ-608.

Configuration initiale recommandée :

- PostgreSQL **18**, version par défaut actuelle de Cloud SQL ;
- édition **Enterprise**, 2 vCPU et 8 Gio ;
- disponibilité `REGIONAL` à Paris, au moins un CPU dédié ;
- private IP uniquement, accès depuis GKE avec le Cloud SQL Auth Proxy ou le
  connector officiel ;
- pool de connexions borné à 20 par replica BFF ;
- PITR activé, 7 jours de WAL ;
- backups automatisés conservés 35 jours ;
- replica interrégion en Belgique, promotion manuelle pendant le drill ;
- chiffrement Google-managed au lancement ; CMEK seulement si une exigence
  contractuelle l'impose.

Cloud SQL supporte PostgreSQL 18 et applique automatiquement les versions
mineures. L'édition Enterprise fournit les capacités principales avec un SLA
base plus économique que Enterprise Plus ; Enterprise Plus ajoute notamment
le DR avancé et le connection pooling managé, mais n'est pas nécessaire à la
beta
([Cloud SQL, versions](https://docs.cloud.google.com/sql/docs/postgres/db-versions),
[Cloud SQL, editions](https://docs.cloud.google.com/sql/docs/postgres/editions-intro)).

Une instance HA régionale bascule entre zones avec la même IP. Une replica
interrégion est asynchrone et sa promotion est intentionnelle : elle ne permet
donc pas de promettre un RPO nul lors d'une perte complète de région
([Cloud SQL, availability](https://docs.cloud.google.com/sql/docs/postgres/availability),
[Cloud SQL, cross-region replicas](https://cloud.google.com/sql/docs/postgres/replication/cross-region-replicas)).

Cloud SQL impose des limites globales de connexion ; le pool doit donc rester
borné même si le BFF scale
([Cloud SQL, manage connections](https://docs.cloud.google.com/sql/docs/postgres/manage-connections)).

## Régions et reprise

### Région active : Paris

`europe-west9` est retenue pour :

- proximité des premiers opérateurs et adopteurs ;
- résidence principale des données en France ;
- disponibilité de Cloud SQL et Secret Manager ;
- faible latence entre GKE, Cloud SQL, Secret Manager et le disque régional.

### Région DR : Belgique

`europe-west1` est retenue parce qu'elle est géographiquement distincte, dans
l'Union européenne et compatible avec les services choisis. Cloud SQL et
Secret Manager sont disponibles dans les deux régions
([Cloud SQL regions](https://docs.cloud.google.com/sql/docs/postgres/region-availability-overview),
[Secret Manager locations](https://docs.cloud.google.com/secret-manager/docs/locations)).

La Belgique est active pour la replica PostgreSQL et le control plane GKE, mais
ne contient aucun writer Tasq Server en fonctionnement normal. Un runbook
protégé :

1. gèle le routage vers Paris ;
2. vérifie l'heure et le digest du dernier backup Tasq complet ;
3. promeut la replica PostgreSQL ou restaure le backup prévu ;
4. restaure chaque tenant dans un nouveau volume absent ;
5. exécute `tasq check`, une lecture et un retry de mutation idempotent ;
6. ouvre le trafic vers la Belgique seulement après readiness.

## Sauvegardes

Le backup primaire des ledgers est le backup applicatif TQ-807, pas un snapshot
brut :

- un CronJob déclenche `tasq backup` toutes les heures ;
- le job échoue si `.complete`, les tailles ou les digests sont absents ;
- le bundle complet est envoyé dans un bucket configurable dual-region
  `EUROPE-WEST9` + `EUROPE-WEST1` ;
- une politique de rétention de 35 jours est verrouillée après un premier test
  de suppression contrôlée ;
- soft delete reste activé ;
- une restauration réelle dans le cluster DR est exécutée chaque semaine
  jusqu'à trois succès consécutifs, puis chaque mois.

Cloud Storage permet des dual-regions configurables en choisissant deux régions
européennes. Bucket Lock peut rendre une politique de rétention irréductible et
soft delete protège les suppressions accidentelles ou malveillantes
([Cloud Storage locations](https://docs.cloud.google.com/storage/docs/bucket-locations),
[Bucket Lock](https://docs.cloud.google.com/storage/docs/bucket-lock),
[soft delete](https://docs.cloud.google.com/storage/docs/soft-delete)).

Backup for GKE reste une seconde couche pour les manifests Kubernetes et les
PVC. Il sait sauvegarder les Persistent Disks et restaurer dans un autre
cluster, mais ne remplace ni le checkpoint SQLite ni le manifeste Tasq digesté
([Backup for GKE](https://docs.cloud.google.com/kubernetes-engine/docs/add-on/backup-for-gke/concepts/backup-for-gke)).

Cloud SQL utilise PITR et ses propres backups. Les backups standard permettent
1 à 365 jours de rétention et la restauration interrégion
([Cloud SQL backup options](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options),
[Cloud SQL PITR](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr)).

## Secrets et identités

### Secret Manager

Secret Manager contient uniquement :

- peppers d'identité, session et enrollment ;
- configuration privée de l'IdP ;
- credential de connexion PostgreSQL si l'IAM database authentication n'est
  pas encore disponible dans l'adapter ;
- références de signing authority ;
- secrets de webhook ou d'alerting opérateur.

Les versions sont répliquées explicitement à Paris et en Belgique. Chaque
workload possède un service account distinct et le rôle minimal sur les seuls
secrets nécessaires. Les applications lisent une version au démarrage et lors
d'une rotation, jamais à chaque requête.

Secret Manager facture les versions actives et les accès. Les six premières
versions et 10 000 accès mensuels sont inclus ; au-delà, le coût est faible
mais les anciennes versions actives doivent être détruites après la fenêtre de
rollback
([Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)).

### Identity Platform

Identity Platform est retenu pour les humains :

- un tenant Identity Platform par tenant Tasq lorsque l'isolation B2B est
  nécessaire ;
- Google et email pour la beta ;
- OIDC/SAML configurable ensuite pour les clients entreprise ;
- TOTP obligatoire pour mainteneurs, support et recovery operators ;
- callback vérifié côté BFF, puis création de la session Tasq `__Host-` ;
- l'ID tenant de l'IdP est un input authentifié de la résolution de membership,
  jamais une autorité Tasq implicite.

Identity Platform isole par tenant les utilisateurs, fournisseurs d'identité,
configurations et quotas. Il supporte OIDC et TOTP
([Identity Platform multi-tenancy](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy),
[OIDC sign-in](https://docs.cloud.google.com/identity-platform/docs/web/oidc),
[TOTP MFA](https://docs.cloud.google.com/identity-platform/docs/admin/enabling-totp-mfa)).

Son prix actuel est gratuit jusqu'à 50 000 MAU pour email/social, mais OIDC et
SAML ne sont gratuits que jusqu'à 50 MAU puis coûtent 0,015 USD par MAU. Il
faut exposer ce coût dans le pricing entreprise, pas l'absorber sans limite
([Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)).

Les Pods et GitHub Actions n'utilisent pas de clés de service account. GKE
utilise Workload Identity Federation ; GitHub utilise un pool dédié à
l'environnement protégé. Google recommande cette approche et qualifie les clés
de service account de risque de sécurité
([Google IAM workload identities](https://docs.cloud.google.com/iam/docs/workload-identities),
[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation)).

## Registry et déploiement

Artifact Registry contient :

- l'image privée du Cloud control plane/BFF ;
- les charts ou manifests de déploiement ;
- une copie promue de l'image Server publique certifiée.

La promotion Server doit :

1. partir du digest GHCR protégé exact ;
2. vérifier provenance et SBOM avant copie ;
3. copier sans rebuild ;
4. vérifier que le digest de manifest attendu est conservé ou enregistrer
   explicitement le nouveau digest d'index et sa relation aux manifests ;
5. déployer uniquement `registry/name@sha256:...`.

Artifact Registry offre un stockage régional ou multi-régional. Les 0,5
premiers Gio sont gratuits ; le transfert d'un repository multi-région Europe
vers une région européenne est gratuit
([Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)).

Cloud Deploy gère deux targets, `staging-paris` et `production-paris`, avec :

- vérification post-déploiement ;
- approbation manuelle avant production ;
- rollback par redéploiement du digest antérieur, jamais par tag mutable ;
- un pipeline DR séparé qui ne peut être déclenché que par le rôle incident.

Cloud Deploy cible GKE et récupère les images depuis Artifact Registry. Le
premier pipeline multi-target actif d'un compte de facturation est gratuit
([Cloud Deploy overview](https://docs.cloud.google.com/deploy/docs/overview),
[Cloud Deploy pricing](https://cloud.google.com/deploy)).

## Observabilité et SLO

Configuration initiale :

- logs JSON sur stdout, sans titres, evidence, workspace IDs, principals,
  tokens ni chemins de base ;
- rétention Cloud Logging de 30 jours ;
- exclusion des health checks réussis ;
- `/metrics` scrapé toutes les 60 secondes ;
- alertes sur readiness, taux 5xx, p95/p99, saturation CPU/mémoire, espace
  disque, retry SQLite, taille WAL, ancienneté du dernier backup, lag de la
  replica PostgreSQL et expiration des certificats ;
- uptime check depuis au moins trois régions ;
- dashboard séparant control plane, BFF et chaque tenant Server ;
- budget alerts à 50 %, 75 %, 90 % et 100 %.

Managed Service for Prometheus est activé par défaut dans GKE Autopilot. Sa
facturation dépend du nombre d'échantillons ; passer de 15 à 60 secondes réduit
ce volume d'environ 75 %
([Managed Prometheus on GKE](https://docs.cloud.google.com/stackdriver/docs/managed-prometheus/setup-managed),
[observability cost controls](https://docs.cloud.google.com/stackdriver/docs/observability/pricing-optimize-and-monitor)).

Cloud Logging inclut les 50 premiers Gio par projet et 30 jours de rétention ;
les métriques Prometheus commencent à 0,06 USD par million d'échantillons
([Google Cloud Observability pricing](https://cloud.google.com/products/observability/pricing)).

Objectifs beta à inscrire dans le manifeste de readiness uniquement après
drills réels :

- disponibilité : **99,5 % sur 28 jours** ;
- RPO perte de région : **60 minutes** ;
- RTO perte de région : **120 minutes** ;
- rétention des backups ledger : **35 jours** ;
- remote effects : **false**.

Il ne faut pas annoncer 99,9 %, RPO 15 minutes ou RTO 30 minutes avant d'avoir
automatisé et mesuré les drills correspondants.

## Coût et limites

Les montants suivants sont des enveloppes de décision, pas des devis. Le
calculator officiel doit être figé dans les preuves avant provisioning.

### Coût fixe mensuel estimé

| Poste | Enveloppe beta |
|---|---:|
| GKE Autopilot control plane actif + DR | 75–150 USD |
| BFF/control plane, deux petits Pods | 80–140 USD |
| Cloud SQL PostgreSQL HA + replica DR | 250–500 USD |
| Load balancer, Armor, DNS | 25–70 USD |
| Logs, métriques, registry, secrets, backups | 20–100 USD |
| **Total fixe** | **450–960 USD/mois** |

GKE facture les ressources demandées par les Pods et applique un crédit mensuel
de 74,40 USD, équivalent à un cluster Autopilot ou zonal. Un second cluster
consomme donc normalement le coût de gestion non couvert
([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)).

Le load balancer facture au minimum 0,025 USD par heure pour les premières
règles, puis le trafic traité
([Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing)).

### Coût marginal

Avec un Pod Server de 1 vCPU / 2 Gio et 20 Gio de disque régional :

- prévoir **45–80 USD par tenant actif et par mois** ;
- un tenant à plusieurs workspaces partage ce Pod et ce volume ;
- l'isolation par tenant rend le coût lisible mais linéaire.

Un plafond initial de **1 500 USD/mois** doit arrêter l'admission automatique.
Le quota commercial de la beta est fixé à **10 tenants actifs** tant qu'un mois
réel n'a pas validé le coût marginal.

### Limites structurantes

- SQLite WAL n'accepte qu'un writer à la fois.
- Un tenant ne scale pas horizontalement ; il scale verticalement.
- Un Persistent Disk régional protège une panne de zone, pas une panne de
  région.
- Une replica Cloud SQL interrégion est asynchrone.
- Le Server accepte au maximum 1 000 workspaces par configuration, mais cette
  limite de parsing n'est pas une capacité recommandée.
- La configuration Server est statique ; le provider adapter doit produire un
  rollout contrôlé après ajout ou retrait de workspace.
- Un Pod par tenant devient économiquement mauvais avant que GKE lui-même ne
  devienne techniquement limitant.

## Plan de montée en charge

### Phase A — beta, 1 à 10 tenants

- un Server par tenant ;
- 1 vCPU, 2 Gio, 20 Gio ;
- maximum 25 workspaces par tenant sans capacity review ;
- aucune autoscaling horizontal du Server ;
- deux replicas BFF/control plane ;
- drills backup hebdomadaires ;
- admission mainteneur uniquement.

### Phase B — 10 à 25 tenants

- augmenter verticalement les tenants qui dépassent les seuils ;
- automatiser provisioning, rotation, backup et suppression vérifiée ;
- tester 25 tenants aux noms de workspace collisionnels ;
- mesurer coût par tenant et charge de support ;
- préparer le design d'un Server shard multi-tenant ou du port PostgreSQL
  complet, sans l'implémenter par défaut.

Déclencheurs de capacity review :

- CPU supérieur à 60 % pendant 15 minutes ;
- mémoire supérieure à 70 % ;
- espace libre inférieur à 30 % ;
- p95 mutation supérieur à 500 ms ;
- retry/busy SQLite supérieur à 0,1 % ;
- backup supérieur à 15 minutes ;
- coût marginal supérieur à 80 USD par tenant.

### Phase C — au-delà de 25 tenants ou d'un seuil dépassé

Trancher entre :

1. **server shards multi-tenant isolés**, moins coûteux mais exigeant une
   nouvelle analyse de blast radius et de routage ;
2. **adapter PostgreSQL complet du Server/Core**, plus profond mais permettant
   plusieurs replicas stateless et une migration ultérieure vers Cloud Run.

Le port PostgreSQL complet doit être traité comme une migration de format et
de recovery, avec dual-run, comparaison state-based, rollback et certification
TQ-608. Il ne doit jamais être une substitution mécanique de driver SQL.

### Phase D — cible élastique

Après certification PostgreSQL complète seulement :

- BFF/control plane et Server stateless sur Cloud Run ou GKE Deployment ;
- Cloud SQL Enterprise Plus ou AlloyDB si les mesures l'exigent ;
- autoscaling horizontal ;
- DR avancé automatisé ;
- objectif 99,9 % ou 99,95 % mesuré ;
- RPO 15 minutes et RTO 30 minutes après trois drills réussis.

## Alternatives rejetées

| Option | Verdict | Motif |
|---|---|---|
| Cloud Run + filesystem local | Rejetée | Filesystem jetable |
| Cloud Run + NFS | Rejetée | SQLite WAL et filesystem réseau incompatibles |
| AWS ECS/Fargate + EBS | Rejetée pour v1 | Le volume EBS d'une tâche de service ECS est supprimé à la terminaison de la tâche ; reprise stateful moins naturelle |
| AWS ECS/Fargate + EFS | Rejetée | EFS est un filesystem réseau, mauvais couple avec SQLite WAL |
| VM unique | Plan de secours seulement | Compatible SQLite mais davantage d'opérations artisanales, moins de preuves déclaratives |
| PostgreSQL complet avant beta | Rejeté | Chantier large et risqué sans données d'usage justifiant le coût |

AWS documente que les volumes EBS attachés aux tâches d'un service ECS sont
toujours supprimés à la terminaison de la tâche
([AWS ECS with EBS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)).

## Ordre d'exécution recommandé

1. Publier et certifier l'image Server protégée exacte.
2. Implémenter et certifier uniquement l'adapter PostgreSQL du Cloud control
   plane.
3. Écrire l'infrastructure as code GCP dans un projet staging isolé.
4. Déployer staging Paris et le cluster DR Belgique.
5. Brancher Identity Platform, Secret Manager et les workload identities.
6. Exécuter browser, recovery, revocation, backup/restore et hostile matrices.
7. Obtenir les revues indépendantes infrastructure et web.
8. Faire exécuter le drill incident par un opérateur non briefé.
9. Remplir le manifeste readiness avec références protégées.
10. Demander la décision mainteneur ; ne changer la vérité produit qu'après
    autorisation explicite.

## Décisions à ne plus rouvrir sans nouvelle preuve

- provider : Google Cloud ;
- régions : Paris active, Belgique DR ;
- runtime beta : GKE Autopilot ;
- ledger beta : SQLite mono-writer sur Regional Persistent Disk ;
- DB control plane : Cloud SQL PostgreSQL 18 Enterprise ;
- IdP : Identity Platform ;
- registry/deploy : Artifact Registry + Cloud Deploy ;
- SLO beta : 99,5 %, RPO 60 min, RTO 120 min ;
- effets distants : désactivés ;
- pas de Cloud Run avant le port PostgreSQL complet.
