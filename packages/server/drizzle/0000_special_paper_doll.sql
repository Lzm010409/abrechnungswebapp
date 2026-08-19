CREATE TABLE "extraktionen" (
	"datei_id" text PRIMARY KEY NOT NULL,
	"daten" jsonb NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kontoauszuege" (
	"id" text PRIMARY KEY NOT NULL,
	"monat" text NOT NULL,
	"dateiname" text NOT NULL,
	"groesse" integer NOT NULL,
	"seiten" integer,
	"hochgeladen_am" timestamp with time zone NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monate" (
	"monat" text PRIMARY KEY NOT NULL,
	"daten" jsonb NOT NULL,
	"synchronisiert_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"monat" text NOT NULL,
	"position_id" text NOT NULL,
	"patch" jsonb NOT NULL,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overrides_monat_position_id_pk" PRIMARY KEY("monat","position_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"monat" text PRIMARY KEY NOT NULL,
	"daten" jsonb NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "kontoauszuege_monat_idx" ON "kontoauszuege" USING btree ("monat");