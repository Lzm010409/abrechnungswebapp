CREATE TABLE "dateien" (
	"monat" text NOT NULL,
	"datei_id" text NOT NULL,
	"inhalt" "bytea" NOT NULL,
	"groesse" integer NOT NULL,
	"gespeichert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dateien_monat_datei_id_pk" PRIMARY KEY("monat","datei_id")
);
